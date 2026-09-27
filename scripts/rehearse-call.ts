/**
 * Rehearses a call over the real webhook without ringing anyone: builds the
 * cases the daily check would build, inserts a `calls` row by hand, and prints
 * its id so the answer URL can be asked for its XML.
 *
 *   npx tsx scripts/rehearse-call.ts [first_contact|follow_up]
 */
import { asc, eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { calls, cases, employees, tenants } from '@/db/schema';
import { buildContext } from '@/lib/runtime';
import { runDailyCheck } from '@/lib/detection/run';

async function main() {
  const purpose = process.argv[2] === 'follow_up' ? 'follow_up' : 'first_contact';

  const tenant = await withPlatformScope((tx) =>
    tx.query.tenants.findFirst({ where: eq(tenants.slug, 'demo-industries') }),
  );
  if (!tenant) throw new Error('Demo Industries not found');

  const callId = await withTenant(tenant.id, async (tx) => {
    const ctx = await buildContext(tx, tenant.id);
    for (const date of ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']) {
      await runDailyCheck(ctx, { date, trigger: 'manual', createOnly: true });
    }

    const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
    // A reminder only exists for a date that was answered, so stand one up.
    if (purpose === 'follow_up') {
      await tx
        .update(cases)
        .set({ status: 'answered', replyOption: 1, answeredAt: new Date() })
        .where(eq(cases.tenantId, tenant.id));
    }
    const target = purpose === 'follow_up' ? rows[0]! : rows.at(-1)!;

    const employee = await tx.query.employees.findFirst({ where: eq(employees.id, target.employeeId) });
    const [call] = await tx
      .insert(calls)
      .values({
        tenantId: tenant.id,
        caseId: target.id,
        employeeId: employee!.id,
        provider: 'rehearsal',
        purpose,
        fromNumber: ctx.settings.callerId ?? undefined,
        toNumber: employee!.mobileE164,
        attempt: 99,
        status: 'ringing',
        transcript: [],
      })
      .returning();
    return call!.id;
  });

  console.log(callId);
}

main().then(() => process.exit(0));
