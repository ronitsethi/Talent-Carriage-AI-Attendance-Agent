import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { calls } from '@/db/schema';
import { buildContext, type FullContext } from '@/lib/runtime';

/**
 * Plivo's callbacks carry only the call id, so the tenant is looked up first and
 * everything after that runs inside that tenant's scope.
 */
export async function withCallContext<T>(
  callId: string,
  fn: (ctx: FullContext, tenantId: string) => Promise<T>,
): Promise<T | null> {
  const call = await withPlatformScope((tx) =>
    tx.query.calls.findFirst({ where: eq(calls.id, callId), columns: { tenantId: true } }),
  );
  if (!call) return null;
  return withTenant(call.tenantId, async (tx) => fn(await buildContext(tx, call.tenantId), call.tenantId));
}
