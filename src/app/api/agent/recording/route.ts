import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { calls, queries, tenants } from '@/db/schema';
import { env } from '@/lib/env';
import { withCallContext } from '@/lib/voice/resolve';
import { withPlatformScope, withTenant } from '@/db';
import { employeeByNumber } from '@/lib/knowledge';
import { recordingPath, recordingsConfigured, saveRecording } from '@/lib/recordings';
import { endCallQuery } from '@/lib/conversation/queries';

/**
 * Where the talking agent sends a call's recording once the call is over.
 *
 * The worker records both sides as it talks and posts the file here, with the
 * same shared secret as the turn API. It is passed on to storage from here, so
 * the storage account's key lives in one place - this app - and not in the
 * worker as well.
 *
 *   POST ?call=<id>                    a call we placed
 *   POST ?query=<id>&from=<number>     a call somebody made to us
 */

// A few minutes of Opus is well under this; anything bigger is not a call.
const MAX_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  if (!env.AGENT_API_TOKEN || request.headers.get('x-agent-token') !== env.AGENT_API_TOKEN) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
  }
  if (!recordingsConfigured()) return NextResponse.json({ error: 'recordings are not configured' }, { status: 503 });

  const url = new URL(request.url);
  const callId = url.searchParams.get('call');
  const queryId = url.searchParams.get('query');
  const from = url.searchParams.get('from') ?? '';

  const audio = Buffer.from(await request.arrayBuffer());
  if (!audio.length) return NextResponse.json({ error: 'empty recording' }, { status: 400 });
  if (audio.length > MAX_BYTES) return NextResponse.json({ error: 'recording too large' }, { status: 413 });

  if (callId) {
    const saved = await withCallContext(callId, async (ctx) => {
      const path = recordingPath('calls', callId, 'ogg');
      await saveRecording(path, audio);
      await ctx.tx.update(calls).set({ recordingUri: path }).where(eq(calls.id, callId));
      return path;
    });
    return saved ? NextResponse.json({ saved }) : NextResponse.json({ error: 'unknown call' }, { status: 404 });
  }

  if (queryId && from) {
    // The caller's number decides whose query this can be, as it does for every
    // turn of the call.
    const saved = await withPlatformScope(async (tx) => {
      const all = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
      for (const tenant of all) {
        const path = await withTenant(tenant.id, async (t) => {
          const employee = await employeeByNumber(t, tenant.id, from);
          if (!employee) return null;
          const query = await t.query.queries.findFirst({
            where: and(eq(queries.id, queryId), eq(queries.employeeId, employee.id)),
            columns: { id: true },
          });
          if (!query) return null;
          const target = recordingPath('queries', queryId, 'ogg');
          await saveRecording(target, audio);
          await endCallQuery(t, queryId, target);
          return target;
        });
        if (path) return path;
      }
      return null;
    });
    return saved ? NextResponse.json({ saved }) : NextResponse.json({ error: 'unknown query' }, { status: 404 });
  }

  return NextResponse.json({ error: 'say which call or query' }, { status: 400 });
}
