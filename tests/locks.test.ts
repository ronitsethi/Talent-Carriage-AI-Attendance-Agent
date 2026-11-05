import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { actions, approvals, calls, cases, conversations, employees, jobs, managers, messages, queries } from '@/db/schema';
import { approvalSelectionId, followUpSelectionId } from '@/lib/conversation/flow';
import { handleInbound } from '@/lib/conversation/engine';
import { contactCase, contactCaseById } from '@/lib/contact';
import { ensureCase } from '@/lib/detection/run';
import { handlers } from '@/lib/jobs/handlers';
import { Postpone, type Job } from '@/lib/jobs/queue';
import { isLocked, lockMonth, monthLabel, unlockMonths } from '@/lib/locks';
import { takeLineForIncoming } from '@/lib/conversation/queries';
import { linesInUse, takeCallLine } from '@/lib/voice/lines';
import { previewUnlockSend, startUnlockSend } from '@/lib/upload-send';
import { giveAttendance, makeScenario, tapOption, typeText, type Scenario } from './helpers/scenario';

/**
 * Locking a month's attendance, and the three call lines every call shares.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const OCT = '2026-10';
const caseIn = (attDate: string, values: Partial<typeof cases.$inferInsert> = {}) =>
  withTenant(scenario.tenantId, async (tx) => {
    const [row] = await tx
      .insert(cases)
      .values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate, meaning: 'absent_full', ...values })
      .returning();
    return row!;
  });
const read = (id: string) => withTenant(scenario.tenantId, async (tx) => (await tx.query.cases.findFirst({ where: eq(cases.id, id) }))!);

/** A case with the manager, Deepak, asked to approve it, with `hoursLeft` before it goes to HR. */
async function withManager(attDate: string, hoursLeft: number) {
  const managerMobile = `9171000${Math.floor(Math.random() * 90000) + 10000}`;
  const row = await caseIn(attDate, { status: 'awaiting_approval', replyOption: 1, answeredAt: new Date() });
  const approvalId = await withTenant(scenario.tenantId, async (tx) => {
    const [manager] = await tx
      .insert(managers)
      .values({ tenantId: scenario.tenantId, mobileE164: managerMobile, fullName: 'Deepak Gajjar', preferredChannel: 'whatsapp' })
      .returning();
    const [action] = await tx
      .insert(actions)
      .values({
        tenantId: scenario.tenantId,
        caseId: row.id,
        employeeId: scenario.employeeId,
        type: 'apply_leave',
        status: 'awaiting_approval',
        inputs: { what: 'leave', stage: 'applied' },
        idempotencyKey: `leave:${row.id}`,
      })
      .returning();
    const [approval] = await tx
      .insert(approvals)
      .values({
        tenantId: scenario.tenantId,
        actionId: action!.id,
        approverManagerId: manager!.id,
        sentAt: new Date(),
        timeoutAt: new Date(Date.now() + hoursLeft * 3600_000),
      })
      .returning();
    return approval!.id;
  });
  return { row, approvalId, managerMobile };
}

describe('locking a month', () => {
  it('moves every open case of the month to Unresolved, and unlocking puts each back', async () => {
    scenario = await makeScenario();
    const queued = await caseIn('2026-10-03', { status: 'queued' });
    const followUp = await caseIn('2026-10-30', { status: 'answered', replyOption: 1, answeredAt: new Date(), followUpCount: 1, followUpDueAt: new Date() });
    const done = await caseIn('2026-10-10', { status: 'resolved' });
    const november = await caseIn('2026-11-02', { status: 'asked' });

    const locked = await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, OCT, null));
    expect(locked).toEqual({ cases: 2 });
    expect((await read(queued.id)).status).toBe('unresolved');
    expect(await read(followUp.id)).toMatchObject({ status: 'unresolved', followUpCount: 1, lockState: { status: 'answered' } });
    expect((await read(done.id)).status).toBe('resolved');
    expect((await read(november.id)).status).toBe('asked');
    // Locking it again changes nothing.
    expect(await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, OCT, null))).toEqual({ cases: 0 });

    const unlocked = await withTenant(scenario.tenantId, (tx) => unlockMonths(tx, scenario.tenantId, [OCT, '2026-09']));
    expect(unlocked).toEqual({ months: [OCT], cases: 2 });
    expect(await read(queued.id)).toMatchObject({ status: 'queued', lockState: null });
    expect(await read(followUp.id)).toMatchObject({ status: 'answered', followUpCount: 1, lockState: null });
    expect(await withTenant(scenario.tenantId, (tx) => isLocked(tx, scenario.tenantId, '2026-10-15'))).toBe(false);
  });

  it('keeps a manager request from going to HR while locked, and gives it back the time it had left', async () => {
    scenario = await makeScenario();
    const { row, approvalId } = await withManager('2026-10-20', 5);
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, OCT, null));

    // Even long past its time, the timeout job leaves it alone.
    await withTenant(scenario.tenantId, (tx) => tx.update(approvals).set({ timeoutAt: new Date(Date.now() - 3600_000) }).where(eq(approvals.id, approvalId)));
    await handlers.approval_timeout({ tenantId: scenario.tenantId, payload: {} } as unknown as Job);
    expect((await read(row.id)).status).toBe('unresolved');

    await withTenant(scenario.tenantId, (tx) => unlockMonths(tx, scenario.tenantId, [OCT]));
    expect((await read(row.id)).status).toBe('awaiting_approval');
    const approval = await withTenant(scenario.tenantId, async (tx) => (await tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) }))!);
    const hoursLeft = (approval.timeoutAt!.getTime() - Date.now()) / 3600_000;
    expect(hoursLeft).toBeGreaterThan(4.9);
    expect(hoursLeft).toBeLessThan(5.1);
    expect(approval.decision).toBe('pending');
  });

  it('contacts nobody about it and opens no case in it', async () => {
    scenario = await makeScenario();
    const row = await caseIn('2026-10-03', { status: 'queued' });
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-10-04', meaning: 'absent_full' }]);
      await lockMonth(tx, scenario.tenantId, OCT, null);
    });
    const outcome = await withTenant(scenario.tenantId, (tx) => contactCaseById(scenario.context(tx), row.id));
    expect(outcome).toMatchObject({ contacted: false, reason: 'Attendance for this month is locked' });
    expect(await withTenant(scenario.tenantId, (tx) => ensureCase(tx, scenario.tenantId, scenario.employeeId, '2026-10-04'))).toBeNull();
    expect(scenario.channel.history()).toEqual([]);
  });

  it('tells an employee who still replies to a follow-up, once, and changes nothing', async () => {
    scenario = await makeScenario();
    const row = await caseIn('2026-10-30', { status: 'answered', replyOption: 1, answeredAt: new Date(), followUpCount: 1, followUpSentAt: new Date() });
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, OCT, null));

    for (let i = 0; i < 2; i++) {
      const outcome = await withTenant(scenario.tenantId, (tx) =>
        handleInbound(scenario.context(tx), tapOption(scenario.mobile, followUpSelectionId(row.id, 'done'), 'Done')),
      );
      expect(outcome).toMatchObject({ handled: true, caseId: row.id });
    }
    const said = scenario.channel.history(scenario.mobile).map((s) => (s.message as { body?: string }).body);
    expect(said).toEqual([`Hi Ankit, your attendance for ${monthLabel(OCT)} has been locked, so this can no longer be changed here. Please speak to your manager about it.`]);
    expect(await read(row.id)).toMatchObject({ status: 'unresolved', followUpReply: null });
    // Both taps are kept on the case, where HR can read them.
    const kept = await withTenant(scenario.tenantId, (tx) => tx.select().from(messages).where(and(eq(messages.caseId, row.id), eq(messages.direction, 'inbound'))));
    expect(kept).toHaveLength(2);
  });

  it('tells an employee who types an answer to a first question about a locked date', async () => {
    scenario = await makeScenario();
    const row = await caseIn('2026-10-30', { status: 'asked', askedAt: new Date() });
    await withTenant(scenario.tenantId, async (tx) => {
      // The question went out on WhatsApp: the conversation is about this case.
      await tx.insert(conversations).values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, channel: 'whatsapp', activeCaseId: row.id });
      await lockMonth(tx, scenario.tenantId, OCT, null);
    });
    await withTenant(scenario.tenantId, (tx) => handleInbound(scenario.context(tx), typeText(scenario.mobile, '1')));
    const said = scenario.channel.history(scenario.mobile).map((s) => (s.message as { body?: string }).body ?? '');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('has been locked');
    expect((await read(row.id)).status).toBe('unresolved');
  });

  it('tells a manager who decides a request about a locked date, once, and decides nothing', async () => {
    scenario = await makeScenario();
    const { row, approvalId, managerMobile } = await withManager('2026-10-20', 20);
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, OCT, null));

    for (let i = 0; i < 2; i++) {
      await withTenant(scenario.tenantId, (tx) =>
        handleInbound(scenario.context(tx), tapOption(managerMobile, approvalSelectionId(approvalId, 'approve'), 'Approved')),
      );
    }
    const said = scenario.channel.history(managerMobile).map((s) => (s.message as { body?: string }).body);
    expect(said).toEqual([`${monthLabel(OCT)}'s attendance for Ankit Panwar (E-1) has been locked, so no action is needed on this request.`]);
    const approval = await withTenant(scenario.tenantId, async (tx) => (await tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) }))!);
    expect(approval.decision).toBe('pending');
    expect((await read(row.id)).status).toBe('unresolved');
  });
});

describe('after unlocking', () => {
  it('offers a customer on automatic to send what is due, follow-ups first', async () => {
    scenario = await makeScenario({ operatingMode: 'automatic', attendanceSource: 'csv' });
    const unopened = await caseIn('2026-10-03', { status: 'queued' });
    await caseIn('2026-10-04', { status: 'answered', replyOption: 1, answeredAt: new Date(Date.now() - 2 * 86_400_000), followUpDueAt: new Date() });
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, OCT, null));
    // While locked, nothing of it is due.
    expect(await previewUnlockSend(scenario.tenantId, [OCT])).toMatchObject({ people: 0, firstContact: 0, followUps: 0 });

    await withTenant(scenario.tenantId, (tx) => unlockMonths(tx, scenario.tenantId, [OCT]));
    expect(await previewUnlockSend(scenario.tenantId, [OCT])).toMatchObject({ people: 1, firstContact: 1, followUps: 1 });

    await startUnlockSend(scenario.tenantId, [OCT]);
    const queued = await withTenant(scenario.tenantId, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'upload_contact')));
    const stage = (name: string) => queued.find((job) => job.payload.stage === name)!;
    expect(stage('follow_up').priority).toBeLessThan(stage('first_contact').priority);
    expect((await read(unopened.id)).status).toBe('queued');
  });

  it('offers nothing to a customer on manual', async () => {
    scenario = await makeScenario();
    await caseIn('2026-10-03', { status: 'queued' });
    expect(await previewUnlockSend(scenario.tenantId, [OCT])).toBeNull();
  });
});

describe('the three call lines', () => {
  const id = () => crypto.randomUUID();

  it('lets three calls run at once and frees a line when its call ends', async () => {
    scenario = await makeScenario();
    expect(await takeCallLine({ kind: 'call', id: id() })).toBe(true);
    expect(await takeCallLine({ kind: 'call', id: id() })).toBe(true);
    const third = id();
    expect(await takeCallLine({ kind: 'call', id: third })).toBe(true);
    expect(await takeCallLine({ kind: 'call', id: id() })).toBe(false);
    expect(await linesInUse()).toBe(3);

    // The third becomes a real call that rings, then ends.
    await withTenant(scenario.tenantId, (tx) =>
      tx.insert(calls).values({ id: third, tenantId: scenario.tenantId, employeeId: scenario.employeeId, provider: 'plivo', purpose: 'first_contact', status: 'ringing', toNumber: scenario.mobile }),
    );
    expect(await takeCallLine({ kind: 'call', id: id() })).toBe(false);
    await withTenant(scenario.tenantId, (tx) => tx.update(calls).set({ status: 'completed', endedAt: new Date() }).where(eq(calls.id, third)));
    expect(await takeCallLine({ kind: 'call', id: id() })).toBe(true);
  });

  it('never rings one number twice at once', async () => {
    scenario = await makeScenario();
    const first = id();
    expect(await takeCallLine({ kind: 'call', id: first }, scenario.mobile)).toBe(true);
    await withTenant(scenario.tenantId, (tx) =>
      tx.insert(calls).values({ id: first, tenantId: scenario.tenantId, employeeId: scenario.employeeId, provider: 'plivo', purpose: 'follow_up', status: 'in_progress', toNumber: scenario.mobile }),
    );
    expect(await takeCallLine({ kind: 'call', id: id() }, scenario.mobile)).toBe(false);
    expect(await takeCallLine({ kind: 'call', id: id() }, '919999999999')).toBe(true);
  });

  it('counts calls made to us, and turns one away when every line is busy', async () => {
    scenario = await makeScenario();
    await takeCallLine({ kind: 'call', id: id() });
    await takeCallLine({ kind: 'call', id: id() });
    const incoming = id();
    expect(await withTenant(scenario.tenantId, (tx) => takeLineForIncoming(tx, scenario.tenantId, incoming))).toBe(true);
    expect(await withTenant(scenario.tenantId, (tx) => takeLineForIncoming(tx, scenario.tenantId, id()))).toBe(false);

    // Their call ends: the line is free again.
    await withTenant(scenario.tenantId, (tx) =>
      tx.insert(queries).values({ id: incoming, tenantId: scenario.tenantId, employeeId: scenario.employeeId, channel: 'voice', endedAt: new Date() }),
    );
    expect(await withTenant(scenario.tenantId, (tx) => takeLineForIncoming(tx, scenario.tenantId, id()))).toBe(true);
  });

  it('makes a call wait for a free line, follow-ups first, and rings it once one is free', async () => {
    scenario = await makeScenario({ defaultChannel: 'voice' }, { preferredChannel: 'voice' });
    const row = await caseIn('2026-11-02', { status: 'queued' });
    const held = [id(), id(), id()];
    for (const holder of held) await takeCallLine({ kind: 'call', id: holder });

    const outcome = await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const caseRow = (await tx.query.cases.findFirst({ where: eq(cases.id, row.id) }))!;
      const employee = (await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }))!;
      return contactCase(ctx, caseRow, employee);
    });
    expect(outcome).toMatchObject({ contacted: true, waiting: true });
    expect(scenario.voice.history()).toHaveLength(0);

    const [waiting] = await withPlatformScope((tx) => tx.select().from(jobs).where(like(jobs.dedupeKey, `waiting:case:${row.id}:%`)));
    expect(waiting).toMatchObject({ kind: 'waiting_call', priority: 4, status: 'pending' });

    // Still busy: put back for later, not failed.
    await expect(handlers.waiting_call(waiting as Job)).rejects.toBeInstanceOf(Postpone);

    // A line frees: the waiting call rings.
    await withPlatformScope((tx) => tx.execute(sql`update call_lines set holder_id = null where holder_id = ${held[0]}`));
    await handlers.waiting_call(waiting as Job);
    const rung = await withTenant(scenario.tenantId, (tx) => tx.select().from(calls).where(eq(calls.caseId, row.id)));
    expect(rung).toHaveLength(1);
    expect((await read(row.id)).status).toBe('asked');
  });
});
