import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { auditLog, cases, employees, jobs, messages, tenantChannels, tenants, tenantSettings, users } from '@/db/schema';
import { createCustomer, CustomerRefused, customerSlug, deleteCustomer, setCustomerActive } from '@/lib/customers';
import { runDailyCheck } from '@/lib/detection/run';
import { enqueue } from '@/lib/jobs/queue';
import { buildContext } from '@/lib/runtime';
import { giveAttendance, makeScenario } from './helpers/scenario';

// A name unique to this run, so it never meets real rows or another test's.
const tag = Math.random().toString(36).slice(2, 8);
const made: string[] = [];

async function create(name: string) {
  const customer = await createCustomer(name);
  made.push(customer.id);
  return customer;
}

afterEach(async () => {
  if (made.length) await withPlatformScope((tx) => tx.delete(tenants).where(inArray(tenants.id, made)));
  made.length = 0;
});

describe('adding a customer', () => {
  it('turns a name into a slug', () => {
    expect(customerSlug('Sharma & Sons Pvt. Ltd.')).toBe('sharma-sons-pvt-ltd');
    expect(customerSlug('  Café Noir  ')).toBe('cafe-noir');
    expect(customerSlug('शर्मा')).toBe('');
  });

  it('creates an active customer that cannot message anyone yet', async () => {
    const { id, name } = await create(`  Acme   ${tag} `);
    expect(name).toBe(`Acme ${tag}`);

    const { tenant, settings, channels, logins } = await withPlatformScope(async (tx) => ({
      tenant: await tx.query.tenants.findFirst({ where: eq(tenants.id, id) }),
      settings: await tx.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, id) }),
      channels: await tx.select().from(tenantChannels).where(eq(tenantChannels.tenantId, id)),
      logins: await tx.select().from(users).where(eq(users.tenantId, id)),
    }));

    expect(tenant).toMatchObject({ slug: `acme-${tag}`, status: 'active' });
    expect(settings).toMatchObject({ sendingEnabled: false, operatingMode: 'manual', actionsEnabled: false });
    expect(channels).toEqual([]);
    expect(logins).toEqual([]);
  });

  it('refuses a name already taken, however it is spelt', async () => {
    await create(`Acme ${tag}`);
    await expect(create(`ACME  ${tag}.`)).rejects.toThrow(CustomerRefused);
  });

  it('refuses a name it cannot use', async () => {
    await expect(create('   ')).rejects.toThrow(CustomerRefused);
    await expect(create('शर्मा')).rejects.toThrow(CustomerRefused);
    await expect(create('a'.repeat(121))).rejects.toThrow(CustomerRefused);
  });
});

describe('deactivating and deleting a customer', () => {
  it('stops sending while deactivated, keeps its own switch, and restarts', async () => {
    const { id } = await create(`Paused ${tag}`);
    await withPlatformScope((tx) => tx.update(tenantSettings).set({ sendingEnabled: true }).where(eq(tenantSettings.tenantId, id)));
    const sending = () => withTenant(id, async (tx) => (await buildContext(tx, id)).settings.sendingEnabled);

    await setCustomerActive(id, false);
    expect(await sending()).toBe(false);

    await setCustomerActive(id, true);
    expect(await sending()).toBe(true);
  });

  it('cancels sends waiting after an upload', async () => {
    const { id } = await create(`Waiting ${tag}`);
    await enqueue('upload_contact', { employeeId: 'x', stage: 'first_contact' }, { tenantId: id, runAt: new Date(Date.now() + 3_600_000), dedupeKey: `test:${tag}` });

    await setCustomerActive(id, false);

    expect(await withPlatformScope((tx) => tx.select().from(jobs).where(eq(jobs.tenantId, id)))).toEqual([]);
  });

  it('refuses to delete a customer that is still active', async () => {
    const { id } = await create(`Live ${tag}`);
    await expect(deleteCustomer(id)).rejects.toThrow(CustomerRefused);
    expect(await withPlatformScope((tx) => tx.query.tenants.findFirst({ where: eq(tenants.id, id) }))).toBeTruthy();
  });

  it('refuses to take a Talent Carriage login down with it', async () => {
    const { id } = await create(`Staff ${tag}`);
    await withPlatformScope((tx) =>
      tx.insert(users).values({ tenantId: id, email: `staff-${tag}@talentcarriage.test`, name: 'Staff', role: 'platform_admin' }),
    );
    await setCustomerActive(id, false);
    await expect(deleteCustomer(id)).rejects.toThrow(/Talent Carriage login/);
  });

  it('removes everything of a customer with real history, except the audit trail', async () => {
    const scenario = await makeScenario();
    const id = scenario.tenantId;
    await withTenant(id, async (tx) => {
      await giveAttendance(tx, id, scenario.employeeId, [{ date: '2026-08-17', meaning: 'absent_full', raw: 'A|A' }]);
      await runDailyCheck(scenario.context(tx), { date: '2026-08-17', trigger: 'manual' });
    });
    await withPlatformScope((tx) => tx.insert(auditLog).values({ tenantId: id, actorType: 'system', action: 'test', entity: 'test' }));
    expect(await withPlatformScope((tx) => tx.select().from(messages).where(eq(messages.tenantId, id)))).not.toEqual([]);

    await setCustomerActive(id, false);
    await deleteCustomer(id);

    const left = await withPlatformScope(async (tx) => ({
      tenant: await tx.select().from(tenants).where(eq(tenants.id, id)),
      people: await tx.select().from(employees).where(eq(employees.tenantId, id)),
      cases: await tx.select().from(cases).where(eq(cases.tenantId, id)),
      messages: await tx.select().from(messages).where(eq(messages.tenantId, id)),
      audit: await tx.select().from(auditLog).where(eq(auditLog.tenantId, id)),
    }));
    expect(left).toMatchObject({ tenant: [], people: [], cases: [], messages: [] });
    expect(left.audit).toHaveLength(1);
  });
});
