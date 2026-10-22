import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { calls, queries, tenants } from '@/db/schema';
import { employeeByNumber } from '@/lib/knowledge';
import { withCallContext } from '@/lib/voice/resolve';
import { fetchPlivoRecording, recordingPath, saveRecording } from '@/lib/recordings';
import { endCallQuery } from '@/lib/conversation/queries';

/**
 * Plivo's word that a call's recording is ready.
 *
 * The answer XML asked Plivo to record the whole call (see `recordSession`);
 * once the call has ended it posts here where the file is. It is collected
 * straight away and kept with the call's other recordings, rather than left on
 * Plivo, where it would be deleted after 90 days.
 *
 *   ?call=<id>                    a keypad call we placed
 *   ?query=<id>&from=<number>     a call somebody made to the company number
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const form = await request.formData().catch(() => new FormData());
  const recordUrl = String(form.get('RecordUrl') ?? '');
  if (!recordUrl) return NextResponse.json({ received: true });

  const callId = url.searchParams.get('call');
  const queryId = url.searchParams.get('query');
  const from = url.searchParams.get('from') ?? '';

  try {
    if (callId) {
      await withCallContext(callId, async (ctx) => {
        const path = recordingPath('calls', callId, 'mp3');
        await saveRecording(path, await fetchPlivoRecording(recordUrl));
        await ctx.tx.update(calls).set({ recordingUri: path }).where(eq(calls.id, callId));
        return path;
      });
    } else if (queryId && from) {
      await withPlatformScope(async (tx) => {
        const all = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
        for (const tenant of all) {
          const done = await withTenant(tenant.id, async (t) => {
            const employee = await employeeByNumber(t, tenant.id, from);
            if (!employee) return false;
            const query = await t.query.queries.findFirst({
              where: and(eq(queries.id, queryId), eq(queries.employeeId, employee.id)),
              columns: { id: true },
            });
            if (!query) return false;
            const path = recordingPath('queries', queryId, 'mp3');
            await saveRecording(path, await fetchPlivoRecording(recordUrl));
            await endCallQuery(t, queryId, path);
            return true;
          });
          if (done) return;
        }
      });
    }
  } catch (error) {
    // Plivo does not retry this, and the call itself is unaffected; the record
    // simply has no audio.
    console.error('[voice] could not keep a recording:', (error as Error).message);
  }

  return NextResponse.json({ received: true });
}

export const GET = POST;
