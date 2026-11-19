import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { policyDocuments } from '@/db/schema';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { readFile, recordingsConfigured } from '@/lib/recordings';

/**
 * A guideline document, for its preview on the Guidelines page: the PDF as it
 * was uploaded, or with `?text` the text the agent reads from it (all there is
 * for a document added before files were kept).
 *
 * The row is looked up for the signed-in customer (inside `withTenant` and by
 * its customer id), so somebody signed in to one customer cannot fetch another
 * customer's document by guessing its id - they get the same 404 as for one
 * that does not exist.
 * The page frames the PDF, so this route alone may be framed, by this site.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A filename for the header: no quotes, slashes or line breaks. */
const safeName = (name: string) => name.replace(/["\\/\r\n]/g, '_');

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response('not signed in', { status: 401 });
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return new Response('no customer chosen', { status: 403 });

  const { id } = await params;
  if (!UUID.test(id)) return new Response('not found', { status: 404 });
  // The customer named outright as well as by row-level security, so neither alone stands between customers.
  const doc = await withTenant(tenantId, (tx) =>
    tx.query.policyDocuments.findFirst({ where: and(eq(policyDocuments.tenantId, tenantId), eq(policyDocuments.id, id)) }),
  );
  if (!doc) return new Response('not found', { status: 404 });

  const privateHeaders = { 'Cache-Control': 'private, no-store' };
  if (new URL(request.url).searchParams.has('text')) {
    return new Response(doc.content ?? '', { headers: { ...privateHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  if (!doc.filePath || !recordingsConfigured()) return new Response('the original file was not kept', { status: 404 });
  let file: Awaited<ReturnType<typeof readFile>>;
  try {
    file = await readFile(doc.filePath);
  } catch (error) {
    console.error(`guideline file ${doc.filePath} could not be read`, error);
    return new Response('the document could not be read', { status: 502 });
  }
  const download = new URL(request.url).searchParams.has('download');
  return new Response(file.body, {
    headers: {
      ...privateHeaders,
      'Content-Type': 'application/pdf',
      'Content-Length': String(file.size),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${safeName(doc.filename)}"`,
    },
  });
}
