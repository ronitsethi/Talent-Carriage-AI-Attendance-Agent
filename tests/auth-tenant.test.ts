import { describe, expect, it, vi } from 'vitest';

/**
 * A stale `tc_tenant` cookie - left behind by a database rebuild, or a customer
 * that was removed - must not take a page down. It is ignored, and the session
 * falls back to a customer that actually exists.
 */
const cookieStore = { value: '' };
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'tc_tenant' && cookieStore.value ? { value: cookieStore.value } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

const { getActiveTenantId } = await import('@/lib/auth');
const { withPlatformScope } = await import('@/db');
const { tenants, tenantSettings } = await import('@/db/schema');
const { eq } = await import('drizzle-orm');

const staffSession = {
  userId: 'u1',
  email: 'admin@talentcarriage.test',
  name: 'Admin',
  role: 'platform_admin' as const,
  tenantId: null,
  departmentScope: [],
};

describe('active tenant selection', () => {
  it('ignores a cookie pointing at a customer that no longer exists', async () => {
    const { id } = await withPlatformScope(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ slug: `stale-${Date.now()}`, name: 'Still Here', status: 'active' })
        .returning();
      await tx.insert(tenantSettings).values({ tenantId: tenant!.id });
      return tenant!;
    });

    cookieStore.value = '84a14bde-4910-47cc-9bcd-7f27ff940e55'; // deleted customer
    const resolved = await getActiveTenantId(staffSession);
    expect(resolved).not.toBe(cookieStore.value);
    expect(resolved).toBeTruthy();

    cookieStore.value = id;
    expect(await getActiveTenantId(staffSession)).toBe(id);

    cookieStore.value = 'not-a-uuid';
    expect(await getActiveTenantId(staffSession)).toBeTruthy();

    await withPlatformScope((tx) => tx.delete(tenants).where(eq(tenants.id, id)));
  });

  it('pins a customer user to their own tenant, cookie or not', async () => {
    const [own] = await withPlatformScope((tx) =>
      tx.insert(tenants).values({ slug: `pinned-${Date.now()}`, name: 'Pinned', status: 'active' }).returning(),
    );
    cookieStore.value = '84a14bde-4910-47cc-9bcd-7f27ff940e55';
    const session = { ...staffSession, role: 'hr_admin' as const, tenantId: own!.id };
    expect(await getActiveTenantId(session)).toBe(own!.id);

    await withPlatformScope((tx) => tx.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, own!.id)));
    expect(await getActiveTenantId(session), 'locked out once deactivated').toBeNull();

    await withPlatformScope((tx) => tx.delete(tenants).where(eq(tenants.id, own!.id)));
    expect(await getActiveTenantId(session), 'and once deleted').toBeNull();
  });
});
