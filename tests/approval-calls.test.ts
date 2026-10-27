import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { approvals, calls, cases, employees, managers } from '@/db/schema';
import { runDailyCheck } from '@/lib/detection/run';
import { handleTurn, openingTurn, recordNoAnswer } from '@/lib/voice/session';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * The flow sheet on a keypad call, and the manager's approval on the phone.
 *
 * The keypad walks the same menus WhatsApp does, so an employee who says they
 * applied leave on a call goes to their manager just as one who tapped it would
 * - and a manager set to Call is rung, presses 1 or 2, and the employee hears
 * back the way they are contacted.
 */

let scenario: Scenario;
let managerMobile: string;
afterEach(async () => {
  await scenario?.cleanup();
});

const heard = (turn: { intro?: string; speak: string }) => [turn.intro, turn.speak].filter(Boolean).join(' ');

/** One absent date for a voice employee whose manager Deepak is contacted by `managerChannel`. */
async function absentOnce(opts: { employeeChannel?: 'voice' | 'whatsapp'; managerChannel?: 'voice' | 'whatsapp' } = {}) {
  scenario = await makeScenario(
    { defaultChannel: 'voice', callerId: '+912269871077' },
    { preferredChannel: opts.employeeChannel ?? 'voice' },
  );
  managerMobile = `9170000${Math.floor(Math.random() * 90000) + 10000}`;
  await withTenant(scenario.tenantId, async (tx) => {
    await tx
      .insert(employees)
      .values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile });
    await tx.update(employees).set({ managerMobileE164: managerMobile }).where(eq(employees.id, scenario.employeeId));
    await tx.insert(managers).values({
      tenantId: scenario.tenantId,
      mobileE164: managerMobile,
      fullName: 'Deepak Gajjar',
      preferredChannel: opts.managerChannel ?? 'voice',
    });
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-09-21', meaning: 'absent_full', raw: 'A' }]);
    await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'manual' });
  });
  scenario.voice.clear();
  scenario.channel.clear();
}

async function callFor(tx: Db, purpose: string) {
  const rows = await tx.select().from(calls).where(eq(calls.purpose, purpose));
  return rows.at(-1);
}

/** The employee's call answered: "I was on leave", "applied, waiting". */
async function saysLeaveApplied(tx: Db) {
  const ctx = scenario.context(tx);
  const call = (await callFor(tx, 'first_contact'))!;
  const opening = await openingTurn(ctx, call.id);
  const onLeave = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '3' });
  expect(heard(onLeave)).toContain('Press 2 for');
  return handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '2' });
}

const toManager = () => scenario.channel.history().map((s) => s.message as { to: string; templateName?: string }).filter((m) => m.to === managerMobile);
const toEmployee = () =>
  scenario.channel.history().map((s) => s.message as { to: string; body?: string; templateName?: string; variables?: string[] }).filter((m) => m.to === scenario.mobile);

describe('the keypad walks the flow sheet', () => {
  it('opens the reasons after "I did not come", and settles leave or Loss of Pay', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const call = (await callFor(tx, 'first_contact'))!;
      const opening = await openingTurn(ctx, call.id);
      const reasons = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '1' });
      expect(heard(reasons)).toContain('Press 1 for unwell');
      expect(heard(reasons)).toContain('Press 5 for resigned or left job');

      await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '1' });
      const done = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '2' }); // Loss of Pay
      expect(done.done).toBe(true);
      const row = await tx.query.cases.findFirst({ where: eq(cases.id, opening.nextCaseId!) });
      expect(row).toMatchObject({ status: 'resolved', closeReason: 'Employee chose Loss of Pay', replyOption: 1 });
    });
  });

  it('asks again once at a key that means nothing, then hands over to HR', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const call = (await callFor(tx, 'first_contact'))!;
      const opening = await openingTurn(ctx, call.id);
      await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '2' }); // working
      const first = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '9' });
      expect(first.retry).toBe(true);
      const second = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '9' });
      expect(second.retry).toBe(true);
      const third = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '9' });
      expect(third.done).toBe(true);
      const row = await tx.query.cases.findFirst({ where: eq(cases.id, opening.nextCaseId!) });
      expect(row!.status).toBe('needs_hr');
    });
  });

  it('sends a weekly off to HR as a change request', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const call = (await callFor(tx, 'first_contact'))!;
      const opening = await openingTurn(ctx, call.id);
      await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '4' });
      const done = await handleTurn(ctx, call.id, opening.nextCaseId!, { digits: '1' });
      expect(heard(done)).toContain('weekly off change request');
      const row = await tx.query.cases.findFirst({ where: eq(cases.id, opening.nextCaseId!) });
      expect(row!.status).toBe('needs_hr');
    });
  });
});

describe('the manager on the phone', () => {
  it('is rung about leave applied on a call, and pressing 1 approves it - both then hear on WhatsApp', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const settled = await saysLeaveApplied(tx);
      expect(heard(settled)).toContain('Deepak');

      const managerCall = (await callFor(tx, 'manager_approval'))!;
      expect(managerCall.toNumber).toBe(managerMobile);
      expect(toManager(), 'rung, not messaged').toEqual([]);

      const opening = await openingTurn(ctx, managerCall.id);
      expect(heard(opening)).toContain('Press 1');
      const decided = await handleTurn(ctx, managerCall.id, opening.nextCaseId!, { digits: '1' });
      expect(decided.done).toBe(true);
      expect(heard(decided)).toContain('approved');

      const approval = await tx.query.approvals.findFirst({ where: eq(approvals.decision, 'approved') });
      expect(approval).toBeDefined();
      const row = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-21') });
      expect(row).toMatchObject({ status: 'resolved', closeReason: 'Approved by Deepak Gajjar' });

      // Contacted by Call, but the decision comes in writing: never a call.
      expect(await callFor(tx, 'approval_outcome')).toBeUndefined();
      // Never written to on WhatsApp, so the window is closed: the template.
      expect(toEmployee()).toHaveLength(1);
      expect(toEmployee()[0]).toMatchObject({ templateName: 'approval_outcome' });
      expect(toEmployee()[0]!.variables![3]).toContain('Deepak has approved');
      // And the manager, who decided on the phone, is told on WhatsApp the employee knows.
      expect(toManager()).toHaveLength(1);
      expect(toManager()[0]).toMatchObject({ templateName: 'approval_noted' });
      expect((toManager()[0] as { variables?: string[] }).variables![0]).toBe('Noted - approved. Ankit Panwar has been told on WhatsApp.');
    });
  });

  it('pressing 2 rejects it, and both are told on WhatsApp', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      await saysLeaveApplied(tx);
      const managerCall = (await callFor(tx, 'manager_approval'))!;
      const opening = await openingTurn(ctx, managerCall.id);
      const decided = await handleTurn(ctx, managerCall.id, opening.nextCaseId!, { digits: '2' });
      expect(heard(decided)).toContain('not approved');

      const row = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-21') });
      expect(row).toMatchObject({ status: 'resolved', closeReason: 'Not approved by Deepak Gajjar' });
      expect(await callFor(tx, 'approval_outcome')).toBeUndefined();
      expect(toEmployee()).toHaveLength(1);
      expect(toEmployee()[0]!.variables![3]).toContain('did not approve');
      expect((toManager()[0] as { variables?: string[] }).variables![0]).toContain('not approved');
    });
  });

  it('gets the request on WhatsApp when they miss the call', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      await saysLeaveApplied(tx);
      const managerCall = (await callFor(tx, 'manager_approval'))!;
      await recordNoAnswer(ctx, managerCall.id, 'no_answer');
      expect(toManager().map((m) => m.templateName)).toEqual(['manager_approval_request']);
      const approval = await tx.query.approvals.findFirst({ where: eq(approvals.decision, 'pending') });
      expect(approval!.channel).toBe('whatsapp');
    });
  });

  it('gets the request on WhatsApp after two answers that are not a decision', async () => {
    await absentOnce();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      await saysLeaveApplied(tx);
      const managerCall = (await callFor(tx, 'manager_approval'))!;
      const opening = await openingTurn(ctx, managerCall.id);
      const again = await handleTurn(ctx, managerCall.id, opening.nextCaseId!, { digits: '7' });
      expect(again.retry).toBe(true);
      const ended = await handleTurn(ctx, managerCall.id, opening.nextCaseId!, { digits: '7' });
      expect(heard(ended)).toContain('WhatsApp');
      expect(await tx.query.approvals.findFirst({ where: eq(approvals.decision, 'pending') })).toBeDefined();
    });
  });
});

describe('the employee hearing back', () => {
  it('messages, rather than rings, a manager set to WhatsApp', async () => {
    await absentOnce({ managerChannel: 'whatsapp' });
    await withTenant(scenario.tenantId, async (tx) => {
      await saysLeaveApplied(tx);
      expect(await callFor(tx, 'manager_approval')).toBeUndefined();
      expect(toManager().map((m) => m.templateName)).toEqual(['manager_approval_request']);
      const approval = await tx.query.approvals.findFirst({
        where: and(eq(approvals.decision, 'pending'), eq(approvals.channel, 'whatsapp')),
      });
      expect(approval).toBeDefined();
    });
  });
});
