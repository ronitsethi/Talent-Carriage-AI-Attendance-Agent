import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, withPlatformScope, withTenant } from '@/db';
import { employees, tenants, tenantSettings } from '@/db/schema';

/**
 * The isolation claim in the scope document is "enforced in the database, not
 * filtered in application code". These tests are what make that claim true: a
 * query scoped to tenant A cannot see, update or insert tenant B's rows even
 * though it is the same connection pool and the same application user.
 */
describe('tenant isolation', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await withPlatformScope(async (tx) => {
      const stamp = Date.now();
      const [a] = await tx
        .insert(tenants)
        .values({ slug: `iso-a-${stamp}`, name: 'Isolation A', status: 'active' })
        .returning();
      const [b] = await tx
        .insert(tenants)
        .values({ slug: `iso-b-${stamp}`, name: 'Isolation B', status: 'active' })
        .returning();
      tenantA = a!.id;
      tenantB = b!.id;
      await tx.insert(tenantSettings).values([{ tenantId: tenantA }, { tenantId: tenantB }]);
      await tx.insert(employees).values([
        { tenantId: tenantA, empCode: 'A1', fullName: 'Employee A', mobileE164: '919000000001' },
        { tenantId: tenantB, empCode: 'B1', fullName: 'Employee B', mobileE164: '919000000002' },
      ]);
    });
  });

  afterAll(async () => {
    await withPlatformScope(async (tx) => {
      await tx.delete(tenants).where(eq(tenants.id, tenantA));
      await tx.delete(tenants).where(eq(tenants.id, tenantB));
    });
    await closeDb();
  });

  it('shows a tenant only its own employees', async () => {
    const seen = await withTenant(tenantA, (tx) => tx.select().from(employees));
    expect(seen.map((e) => e.empCode)).toEqual(['A1']);
  });

  it('cannot read another tenant even when its id is known', async () => {
    const stolen = await withTenant(tenantA, (tx) =>
      tx.select().from(employees).where(eq(employees.tenantId, tenantB)),
    );
    expect(stolen).toHaveLength(0);
  });

  it('cannot update another tenant"s rows', async () => {
    const updated = await withTenant(tenantA, (tx) =>
      tx.update(employees).set({ fullName: 'Hijacked' }).where(eq(employees.tenantId, tenantB)).returning(),
    );
    expect(updated).toHaveLength(0);

    const [victim] = await withTenant(tenantB, (tx) => tx.select().from(employees));
    expect(victim!.fullName).toBe('Employee B');
  });

  it('refuses to insert a row belonging to another tenant', async () => {
    // Drizzle wraps driver errors, so the Postgres reason sits on `cause`.
    const attempt = withTenant(tenantA, (tx) =>
      tx.insert(employees).values({ tenantId: tenantB, empCode: 'SMUGGLED', fullName: 'Nope' }),
    );
    const error = await attempt.then(
      () => null,
      (err: Error) => err,
    );
    expect(error, 'insert should have been rejected').not.toBeNull();
    expect(String(error!.cause ?? error!.message)).toMatch(/row-level security/i);

    const smuggled = await withPlatformScope((tx) =>
      tx.select().from(employees).where(eq(employees.empCode, 'SMUGGLED')),
    );
    expect(smuggled).toHaveLength(0);
  });

  it('lets the platform scope see across tenants, for the console and workers', async () => {
    const all = await withPlatformScope((tx) => tx.select().from(employees));
    const codes = all.map((e) => e.empCode);
    expect(codes).toContain('A1');
    expect(codes).toContain('B1');
  });

  it('sees nothing when no tenant is set at all', async () => {
    const rows = await db.select().from(employees);
    expect(rows).toHaveLength(0);
  });
});
