import { and, eq } from 'drizzle-orm';
import { withPlatformScope } from '@/db';
import { jobs, tenants, tenantSettings, users } from '@/db/schema';

/**
 * Adding, deactivating and deleting a customer from the All customers page.
 *
 * Staff only. A tenant can only be written with the platform scope, so every
 * caller of this module must have checked `isPlatformAdmin` first.
 */

const MAX_NAME_LENGTH = 120;

/** A name we cannot use. The message is written to be shown as it is. */
export class CustomerRefused extends Error {}

/** "Sharma & Sons Pvt. Ltd." → "sharma-sons-pvt-ltd" */
export function customerSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Creates the customer and its settings, and nothing else.
 *
 * Active, because nothing in the portal can move a customer out of `onboarding`,
 * and a customer who is not active gets no scheduled checks or incoming calls.
 * That is safe: the settings defaults leave sending off and the mode manual.
 *
 * No `tenant_channels` row, so it shares the platform's WhatsApp and phone numbers.
 * The webhook also treats exactly one such row as a single-customer install, which
 * a row added here could wrongly switch on or off. No user either: staff run it.
 */
export async function createCustomer(rawName: string): Promise<{ id: string; name: string }> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name) throw new CustomerRefused('Enter the customer name.');
  if (name.length > MAX_NAME_LENGTH) throw new CustomerRefused(`Keep the name under ${MAX_NAME_LENGTH} characters.`);

  const slug = customerSlug(name);
  if (!slug) throw new CustomerRefused('The name needs at least one English letter or number.');

  return withPlatformScope(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({ slug, name, status: 'active' })
      .onConflictDoNothing({ target: tenants.slug })
      .returning({ id: tenants.id, name: tenants.name });
    if (!tenant) throw new CustomerRefused(`${name} is already a customer.`);

    await tx.insert(tenantSettings).values({ tenantId: tenant.id });
    return tenant;
  });
}

/**
 * Stops or restarts a customer. While deactivated it contacts nobody, answers
 * nobody and its own users cannot sign in, but all its data stays. Sends waiting
 * after an upload are dropped, so coming back does not set them off.
 */
export async function setCustomerActive(tenantId: string, active: boolean) {
  return withPlatformScope(async (tx) => {
    const [tenant] = await tx
      .update(tenants)
      .set({ status: active ? 'active' : 'suspended', updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))
      .returning({ name: tenants.name });
    if (!tenant) throw new CustomerRefused('That customer no longer exists.');
    if (!active) {
      await tx.delete(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.kind, 'upload_contact'), eq(jobs.status, 'pending')));
    }
    return tenant;
  });
}

/**
 * Removes a customer and everything of theirs for good; the audit trail alone
 * stays. Only a deactivated customer can go, so deleting always takes two steps,
 * and a Talent Carriage login tied to it blocks it rather than going with it.
 */
export async function deleteCustomer(tenantId: string) {
  return withPlatformScope(async (tx) => {
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) throw new CustomerRefused('That customer no longer exists.');
    if (tenant.status !== 'suspended') throw new CustomerRefused(`Deactivate ${tenant.name} before deleting it.`);
    const staff = await tx.query.users.findFirst({ where: and(eq(users.tenantId, tenantId), eq(users.role, 'platform_admin')) });
    if (staff) throw new CustomerRefused(`${staff.email} is a Talent Carriage login tied to ${tenant.name}. Move it first.`);

    await tx.delete(tenants).where(eq(tenants.id, tenantId));
    return { name: tenant.name };
  });
}
