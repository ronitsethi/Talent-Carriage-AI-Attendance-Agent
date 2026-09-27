import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { calls } from '@/db/schema';
import { buildContext, type FullContext } from '@/lib/runtime';

/**
 * Plivo's callbacks carry only the call id, so the tenant is looked up first and
 * everything after that runs inside that tenant's scope.
 */
const UUID = /^[0-9a-f-]{36}$/i;

export async function withCallContext<T>(
  callId: string,
  fn: (ctx: FullContext, tenantId: string) => Promise<T>,
): Promise<T | null> {
  // A malformed or unknown id must not throw: the caller turns null into a
  // polite goodbye, whereas an error would drop the call mid-sentence.
  if (!UUID.test(callId)) return null;

  try {
    const call = await withPlatformScope((tx) =>
      tx.query.calls.findFirst({ where: eq(calls.id, callId), columns: { tenantId: true } }),
    );
    if (!call) return null;
    return await withTenant(call.tenantId, async (tx) => fn(await buildContext(tx, call.tenantId), call.tenantId));
  } catch (error) {
    console.error(`[voice] call ${callId} failed:`, error);
    return null;
  }
}
