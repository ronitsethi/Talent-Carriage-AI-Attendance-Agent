import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { calls, cases, employees } from '@/db/schema';
import { closeCasesExplainedByData, runDailyCheck } from '@/lib/detection/run';
import { handleFollowUpResponse, sendDueFollowUps } from '@/lib/conversation/followup';
import { handleInbound, type TenantSettings } from '@/lib/conversation/engine';
import { followUpSelectionId, selectionId } from '@/lib/conversation/flow';
import { sheetSelectionId, writtenFacts } from '@/lib/conversation/sheet';
import { caseCounts, listCases } from '@/lib/queries';
import { openingTurn, recordNoAnswer } from '@/lib/voice/session';
import { giveAttendance, makeScenario, tapOption, type Scenario } from './helpers/scenario';

/**
 * The follow-ups an employee gets for a date they have not acted on: as many as
 * the customer set, the last warning of loss of pay and moving the case to the
 * manager. Doing it at any point resolves the case and stops them.
 */

const DATE = '2026-08-17';
const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);

let scenario: Scenario;
let managerMobile: string;
afterEach(async () => {
  await scenario?.cleanup();
});

type Sent = { kind: string; to: string; body: string; templateName?: string; variables?: string[]; buttonPayloads?: string[] };
const all = () => scenario.channel.history().map((s) => s.message as unknown as Sent);
const sent = () => all().filter((m) => m.to === scenario.mobile);
const toManager = () => all().filter((m) => m.to === managerMobile);

const context = (tx: Db) => ({ ...scenario.context(tx), hooks: { onFollowUpResponse: async (...args: Parameters<typeof handleFollowUpResponse>) => void (await handleFollowUpResponse(...args)) } });
const theCase = () => withTenant(scenario.tenantId, async (tx) => (await tx.select().from(cases).where(eq(cases.attDate, DATE)))[0]!);
const sweep = (at: Date) => withTenant(scenario.tenantId, (tx) => sendDueFollowUps(context(tx), at));
const tap = (payload: string) => withTenant(scenario.tenantId, (tx) => handleInbound(context(tx), tapOption(scenario.mobile, payload)));

/** One absence, its question sent, and a manager in the file unless asked otherwise. */
async function absence(settings: Partial<TenantSettings> = {}, opts: { manager?: boolean; voice?: boolean } = {}) {
  scenario = await makeScenario(settings, opts.voice ? { preferredChannel: 'voice' } : {});
  managerMobile = `9180000${Math.floor(Math.random() * 90000) + 10000}`;
  await withTenant(scenario.tenantId, async (tx) => {
    if (opts.manager !== false) {
      await tx.insert(employees).values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile });
      await tx.update(employees).set({ managerMobileE164: managerMobile }).where(eq(employees.id, scenario.employeeId));
    }
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: DATE, meaning: 'absent_full', raw: 'A|A' }]);
    await runDailyCheck(scenario.context(tx), { date: DATE, trigger: 'manual' });
  });
}

/** The employee says they were unwell, want leave, and have not applied it yet. */
async function saidNotApplied() {
  const { id } = await theCase();
  for (const payload of [selectionId(id, 1), sheetSelectionId(id, 'unwell'), sheetSelectionId(id, 'leave'), sheetSelectionId(id, 'app_not')]) {
    await tap(payload);
  }
  scenario.channel.clear();
  return id;
}

/** A date already answered and left with this employee, due a follow-up now. */
async function answered(attDate: string) {
  return withTenant(scenario.tenantId, async (tx) => {
    await tx
      .insert(cases)
      .values({
        tenantId: scenario.tenantId,
        employeeId: scenario.employeeId,
        attDate,
        meaning: 'absent_full',
        status: 'answered',
        replyOption: 1,
        answeredAt: new Date(),
        followUpDueAt: new Date(Date.now() - 1000),
        context: { outcome: { code: 'absent_unwell', leaveChoice: 'leave' } },
      })
      .onConflictDoUpdate({
        target: [cases.tenantId, cases.employeeId, cases.attDate],
        set: {
          status: 'answered',
          replyOption: 1,
          answeredAt: new Date(),
          followUpDueAt: new Date(Date.now() - 1000),
          context: { outcome: { code: 'absent_unwell', leaveChoice: 'leave' } },
        },
      });
  });
}

describe('the deadline employees are told', () => {
  it('is the next day', async () => {
    await absence({ maxFollowUps: 2 });
    const caseRow = await theCase();
    const facts = await withTenant(scenario.tenantId, async (tx) => {
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      return writtenFacts(context(tx), caseRow, employee!, '2026-08-19');
    });
    expect(facts.deadline).toBe('20-Aug-2026');
  });
});

describe('with two follow-ups', () => {
  it('sends the first, then the final one, and moves the case to the manager', async () => {
    await absence({ maxFollowUps: 2 });
    await saidNotApplied();

    expect((await listCases(scenario.tenantId, { status: 'follow_up_1' })).map((c) => c.id), 'waiting for the first').toHaveLength(1);
    expect((await sweep(later(0.5))).due, 'not due yet').toBe(0);

    await sweep(later(1.1));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ kind: 'template', templateName: 'attendance_follow_up' });
    expect(sent()[0]!.buttonPayloads).toHaveLength(3);
    expect(toManager()).toEqual([]);
    const first = await theCase();
    expect(first).toMatchObject({ status: 'answered', followUpCount: 1, followUpReply: null });
    expect(await listCases(scenario.tenantId, { status: 'follow_up_1' })).toEqual([]);
    expect((await listCases(scenario.tenantId, { status: 'follow_up_2' })).map((c) => c.id), 'waiting for the second').toEqual([first.id]);
    expect((await caseCounts(scenario.tenantId)).followUpLevels).toEqual({ 2: 1 });

    expect((await sweep(later(1.5))).due, 'the second waits its own day').toBe(0);

    scenario.channel.clear();
    await sweep(later(2.2));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      kind: 'template',
      templateName: 'attendance_final_notice',
      variables: ['Ankit', 'leave', '17-Aug-2026', 'your manager, Deepak'],
    });
    expect(toManager()[0]).toMatchObject({
      templateName: 'manager_approval_request',
      variables: ['Ankit Panwar (E-1)', 'has still not applied leave after 2 follow-ups', '17-Aug-2026', 'Absent - unwell'],
    });

    const final = await theCase();
    expect(final).toMatchObject({ status: 'awaiting_approval', followUpCount: 2, followUpDueAt: null });
    expect(await listCases(scenario.tenantId, { status: 'follow_up_1' })).toEqual([]);
    expect((await listCases(scenario.tenantId, { status: 'follow_up_2' })).map((c) => c.id), 'with the manager, at its level').toEqual([final.id]);
    expect((await caseCounts(scenario.tenantId)).followUpLevels).toEqual({ 2: 1 });
    expect((await sweep(later(30))).due, 'nothing after the last').toBe(0);
  });

  it('resolves on "Done" at the first, and never reaches the second', async () => {
    await absence({ maxFollowUps: 2 });
    const id = await saidNotApplied();
    await sweep(later(3));

    await tap(followUpSelectionId(id, 'done'));
    expect(await theCase()).toMatchObject({ status: 'resolved', followUpReply: 'done' });

    scenario.channel.clear();
    expect((await sweep(later(30))).due).toBe(0);
    expect(all()).toEqual([]);
  });

  it('resolves when the attendance file shows it was done, and hears nothing more', async () => {
    await absence({ maxFollowUps: 2 });
    await saidNotApplied();
    await sweep(later(3));

    await withTenant(scenario.tenantId, async (tx) => {
      const { attendanceDays } = await import('@/db/schema');
      await tx.update(attendanceDays).set({ meaning: 'leave_approved' }).where(eq(attendanceDays.attDate, DATE));
      await closeCasesExplainedByData(tx, scenario.tenantId);
    });
    expect((await theCase()).status).toBe('resolved');

    scenario.channel.clear();
    expect((await sweep(later(30))).due).toBe(0);
    expect(toManager()).toEqual([]);
  });

  it('carries on after "Not done"', async () => {
    await absence({ maxFollowUps: 2 });
    const id = await saidNotApplied();
    await sweep(later(3));

    await tap(followUpSelectionId(id, 'not_done'));
    expect(await theCase()).toMatchObject({ status: 'answered', followUpReply: 'not_done' });

    await sweep(later(5.1));
    expect((await theCase()).status).toBe('awaiting_approval');
  });

  it('stops for HR when they ask for help', async () => {
    await absence({ maxFollowUps: 2 });
    const id = await saidNotApplied();
    await sweep(later(3));

    await tap(followUpSelectionId(id, 'help'));
    expect((await theCase()).status).toBe('needs_hr');
    expect((await sweep(later(30))).due).toBe(0);
  });

  it('turns away a button tapped after the case has gone to the manager', async () => {
    await absence({ maxFollowUps: 1 });
    const id = await saidNotApplied();
    await sweep(later(3));
    scenario.channel.clear();

    await tap(followUpSelectionId(id, 'done'));
    expect((await theCase()).status).toBe('awaiting_approval');
    expect(sent()[0]!.body).toContain('has already moved on');
  });
});

describe('the number of follow-ups', () => {
  it('with one, the only follow-up is the final one', async () => {
    await absence({ maxFollowUps: 1 });
    await saidNotApplied();
    await sweep(later(3));

    expect(sent().map((m) => m.templateName)).toEqual(['attendance_final_notice']);
    expect(toManager()[0]!.variables![1]).toBe('has still not applied leave after 1 follow-up');
  });

  it('with three, two ordinary follow-ups come first', async () => {
    await absence({ maxFollowUps: 3 });
    await saidNotApplied();
    await sweep(later(3));
    await sweep(later(5.1));
    await sweep(later(7.2));

    expect(sent().map((m) => m.templateName)).toEqual(['attendance_follow_up', 'attendance_follow_up', 'attendance_final_notice']);
    expect(await theCase()).toMatchObject({ status: 'awaiting_approval', followUpCount: 3 });
  });
});

describe('on WhatsApp', () => {
  it('uses buttons and plain text while the 24-hour window is open', async () => {
    await absence({ maxFollowUps: 2 });
    const id = await saidNotApplied();

    await withTenant(scenario.tenantId, (tx) => tx.update(cases).set({ followUpDueAt: new Date(Date.now() - 1000) }).where(eq(cases.id, id)));
    await sweep(new Date());
    expect(sent()[0]!.kind).toBe('buttons');

    await withTenant(scenario.tenantId, (tx) => tx.update(cases).set({ followUpDueAt: new Date(Date.now() - 1000) }).where(eq(cases.id, id)));
    await sweep(new Date());
    expect(sent()[1]!.kind).toBe('text');
    expect(sent()[1]!.body).toContain('will lead to loss of pay');
  });

  it('counts nothing when a message is refused, and tries again next time', async () => {
    await absence({ maxFollowUps: 1 });
    await saidNotApplied();

    const refused = vi.spyOn(scenario.channel, 'send').mockRejectedValueOnce(new Error('Template not approved'));
    const result = await sweep(later(3));
    refused.mockRestore();

    expect(result.skipped).toEqual(['Template not approved']);
    expect(await theCase()).toMatchObject({ status: 'answered', followUpCount: 0, error: 'Template not approved' });
    expect(toManager()).toEqual([]);

    await sweep(later(3));
    expect((await theCase()).status).toBe('awaiting_approval');
  });

  it('sends the case to HR when the file names no manager, and says so', async () => {
    await absence({ maxFollowUps: 1 }, { manager: false });
    await saidNotApplied();
    await sweep(later(3));

    expect(sent()[0]!.variables![3]).toBe('HR');
    expect((await theCase()).status).toBe('needs_hr');
  });
});

describe('by call', () => {
  it('rings once for the final notice, names every date, and hangs up', async () => {
    await absence({ maxFollowUps: 1 }, { voice: true });
    await answered(DATE);
    await answered('2026-08-18');

    const result = await sweep(new Date());
    expect(result.called).toBe(1);

    await withTenant(scenario.tenantId, async (tx) => {
      const [call] = await tx.select().from(calls).where(eq(calls.purpose, 'final_notice'));
      expect(call).toBeDefined();

      const turn = await openingTurn(context(tx), call!.id);
      expect(turn.done).toBe(true);
      expect(turn.speak).toContain('17 August');
      expect(turn.speak).toContain('18 August');
      expect(turn.speak).toContain('will lead to loss of pay');
      expect(turn.speak).toContain('your manager, Deepak');
    });
    const rows = await withTenant(scenario.tenantId, (tx) => tx.select().from(cases));
    expect(rows.every((r) => r.status === 'awaiting_approval')).toBe(true);
  });

  it('puts a missed final notice on WhatsApp', async () => {
    await absence({ maxFollowUps: 1 }, { voice: true });
    await answered(DATE);
    await sweep(new Date());
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [call] = await tx.select().from(calls).where(eq(calls.purpose, 'final_notice'));
      await recordNoAnswer(context(tx), call!.id, 'no_answer');
    });
    expect(sent().map((m) => m.templateName)).toEqual(['attendance_final_notice']);
  });

  it('goes the way its level is set, over the employee\'s own setting', async () => {
    await absence({
      maxFollowUps: 3,
      followUpContacts: [
        { channel: 'voice', callMode: 'agent' },
        { channel: 'whatsapp', callMode: null },
      ],
    });
    await answered(DATE);
    scenario.channel.clear();

    await sweep(new Date());
    const [first] = await withTenant(scenario.tenantId, (tx) => tx.select().from(calls));
    expect(first).toMatchObject({ purpose: 'follow_up', provider: 'livekit' });
    expect(sent(), 'a WhatsApp employee is rung for this level').toEqual([]);

    await answered(DATE);
    await sweep(new Date());
    expect(sent().map((m) => m.templateName)).toEqual(['attendance_follow_up']);
    expect(await withTenant(scenario.tenantId, (tx) => tx.select().from(calls))).toHaveLength(1);
  });

  it('leaves a level with nothing set to the employee\'s own setting', async () => {
    await absence({ maxFollowUps: 2, followUpContacts: [{ channel: null, callMode: null }] }, { voice: true });
    await answered(DATE);
    expect((await sweep(new Date())).called).toBe(1);
  });

  it('counts every date one reminder call covers', async () => {
    await absence({ maxFollowUps: 2 }, { voice: true });
    await answered(DATE);
    await answered('2026-08-18');

    expect((await sweep(new Date())).called).toBe(1);
    const rows = await withTenant(scenario.tenantId, (tx) => tx.select().from(cases));
    expect(rows.map((r) => r.followUpCount)).toEqual([1, 1]);
    expect((await sweep(new Date())).due, 'neither is due again yet').toBe(0);
  });
});
