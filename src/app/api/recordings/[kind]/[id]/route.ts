import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { calls, queries } from '@/db/schema';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { readRecording, recordingsConfigured } from '@/lib/recordings';

/**
 * A call's audio, for the player on a case or a query.
 *
 * The container is private and nothing in it is reachable from outside this
 * route: the blob is only named by a row, and the row is only found inside
 * `withTenant`, so somebody signed in to one customer cannot fetch another
 * customer's call by guessing its id - row-level security returns nothing and
 * the answer is the same 404 as for a call that does not exist.
 *
 * Players seek by asking for byte ranges, so a range is passed through to the
 * blob and answered with a 206; without that a recording could only be played
 * from the start.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `bytes=0-`, `bytes=1000-2000`. Anything else is ignored and the whole file goes. */
function asked(header: string | null): { start: number; end?: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || !match[1]) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isFinite(start) || (end !== undefined && (!Number.isFinite(end) || end < start))) return null;
  return { start, end };
}

export async function GET(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const session = await getSession();
  if (!session) return new Response('not signed in', { status: 401 });
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return new Response('no customer chosen', { status: 403 });

  const { kind, id } = await params;
  if ((kind !== 'call' && kind !== 'query') || !UUID.test(id)) return new Response('not found', { status: 404 });
  if (!recordingsConfigured()) return new Response('recordings are not configured', { status: 503 });

  const path = await withTenant(tenantId, async (tx) =>
    kind === 'call'
      ? (await tx.query.calls.findFirst({ where: eq(calls.id, id) }))?.recordingUri ?? null
      : (await tx.query.queries.findFirst({ where: eq(queries.id, id) }))?.recordingUri ?? null,
  );
  if (!path) return new Response('not found', { status: 404 });

  const want = asked(request.headers.get('range'));
  let file: Awaited<ReturnType<typeof readRecording>>;
  try {
    file = await readRecording(path, want);
  } catch (error) {
    console.error(`recording ${path} could not be read`, error);
    return new Response('the recording could not be read', { status: 502 });
  }

  const headers = new Headers({
    'Content-Type': file.contentType,
    'Content-Length': String(file.end - file.start + 1),
    'Accept-Ranges': 'bytes',
    // Private audio: never kept by a shared cache, and never written to disk.
    'Cache-Control': 'private, no-store',
  });
  if (want) headers.set('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
  if (new URL(request.url).searchParams.has('download')) {
    headers.set('Content-Disposition', `attachment; filename="${kind}-${id}.${path.split('.').pop()}"`);
  }
  return new Response(file.body, { status: want ? 206 : 200, headers });
}
