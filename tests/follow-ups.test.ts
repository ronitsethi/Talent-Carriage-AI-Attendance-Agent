import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWorkingDay, today } from '@/lib/dates';
import { eq, inArray } from 'drizzle-orm';
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
/** So many days from now, moved on to a working day: follow-ups only go on working days. */
const later = (days: number) => {
  let at = new Date(Date.now() + days * DAY);
  while (!isWorkingDay(today('Asia/Kolkata', at), { saturdayWorking: false })) at = new Date(at.getTime() + DAY);
  return at;
};

/*
 * The clock is pinned to a Tuesday morning. `later` moves a weekend day on to
 * Monday, so from a real "now" two different offsets could land on the same
 * Monday (from a Wednesday, 3 and 5.1 days both do) and a test failed or passed
 * by the day of the week it was run on.
 */
const TUESDAY_MORNING = new Date('2026-11-17T09:00:00+05:30');

let scenario: Scenario;
let managerMobile: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TUESDAY_MORNING);
});
afterEach(async () => {
  vi.useRealTimers();
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
/** Follow-up rows, one per level. */
const rowsOf = (channels: ('whatsapp' | 'voice')[], callMode: 'keypad' | 'agent' = 'keypad') => channels.map((channel) => ({ channel, callMode }));

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

  it('pauses on "Done" for the next working day, then carries on if the file still shows absent', async () => {
    await absence({ maxFollowUps: 2 });
    const id = await saidNotApplied();
    await sweep(later(3));

    await tap(followUpSelectionId(id, 'done'));
    const paused = await theCase();
    expect(paused).toMatchObject({ status: 'answered', followUpReply: 'done' });
    const pausedUntil = paused.followUpPausedUntil!;
    expect(pausedUntil > today('Asia/Kolkata')).toBe(true);

    // The paused day: nothing.
    scenario.channel.clear();
    expect((await sweep(new Date(`${pausedUntil}T06:00:00Z`))).due).toBe(0);
    // After it, the file still showing absent: the next (last) follow-up goes.
    await sweep(later(30));
    expect(sent().map((m) => m.templateName)).toEqual(['attendance_final_notice']);
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
    // Every row WhatsApp: after two ignored follow-ups a Call row would ring for the third.
    await absence({ maxFollowUps: 3, followUpContacts: rowsOf(['whatsapp', 'whatsapp', 'whatsapp']) });
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

describe('by call: the call rule', () => {
  /** Ready for a call: a second follow-up due (its row set to Call), and the last N contacts ignored. */
  async function readyForCall(dates: string[], settings: Partial<TenantSettings> = {}) {
    await absence({ maxFollowUps: 2, followUpContacts: rowsOf(['whatsapp', 'voice', 'voice']), ...settings });
    for (const date of dates) await answered(date);
    await withTenant(scenario.tenantId, async (tx) => {
      await tx.update(cases).set({ followUpCount: 1 }).where(eq(cases.employeeId, scenario.employeeId));
      await tx.update(employees).set({ ignoredContacts: 2 }).where(eq(employees.id, scenario.employeeId));
    });
    scenario.channel.clear();
  }
  /** Follow-up calls only: a first question may have been a call of its own. */
  const placed = () =>
    withTenant(scenario.tenantId, (tx) => tx.select().from(calls).where(inArray(calls.purpose, ['follow_up', 'final_notice'])));

  it('rings once for the final notice, names every date, and hangs up', async () => {
    await readyForCall([DATE, '2026-08-18']);
    const result = await sweep(later(0));
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
    // The call rule's record: when, and a call on each date.
    expect(rows.map((r) => r.callsMade)).toEqual([1, 1]);
    const employee = await withTenant(scenario.tenantId, (tx) => tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }));
    expect(employee!.lastCallAt).not.toBeNull();
  });

  it('puts a missed final notice on WhatsApp', async () => {
    await readyForCall([DATE]);
    await sweep(later(0));
    scenario.channel.clear();
    await withTenant(scenario.tenantId, async (tx) => {
      const [call] = await tx.select().from(calls).where(eq(calls.purpose, 'final_notice'));
      await recordNoAnswer(context(tx), call!.id, 'no_answer');
    });
    expect(sent().map((m) => m.templateName)).toEqual(['attendance_final_notice']);
  });

  it('sends the first follow-up on WhatsApp, whoever the employee is', async () => {
    await absence({ maxFollowUps: 3 }, { voice: true });
    await answered(DATE);
    await withTenant(scenario.tenantId, (tx) => tx.update(employees).set({ ignoredContacts: 9 }).where(eq(employees.id, scenario.employeeId)));
    scenario.channel.clear();
    await sweep(later(0));
    expect(await placed()).toHaveLength(0);
    expect(sent().map((m) => m.templateName)).toEqual(['attendance_follow_up']);
  });

  it('is WhatsApp until they have ignored enough contacts in a row', async () => {
    await readyForCall([DATE], { maxFollowUps: 3 });
    await withTenant(scenario.tenantId, (tx) => tx.update(employees).set({ ignoredContacts: 1 }).where(eq(employees.id, scenario.employeeId)));
    await sweep(later(0));
    expect(await placed()).toHaveLength(0);
    expect(sent()).toHaveLength(1);
  });

  it('keeps the gap after their last call', async () => {
    await readyForCall([DATE], { maxFollowUps: 3 });
    await withTenant(scenario.tenantId, (tx) => tx.update(employees).set({ lastCallAt: new Date(later(0).getTime() - 86_400_000) }).where(eq(employees.id, scenario.employeeId)));
    await sweep(later(0));
    expect(await placed()).toHaveLength(0);
  });

  it('never calls at a follow-up set to WhatsApp, even with every other condition met', async () => {
    await readyForCall([DATE], { maxFollowUps: 3, followUpContacts: rowsOf(['voice', 'whatsapp', 'voice']) });
    await sweep(later(0));
    expect(await placed()).toHaveLength(0);
    expect(sent().map((m) => m.templateName)).toEqual(['attendance_follow_up']);
  });

  it('by default calls only for the follow-up before the final notice', async () => {
    await readyForCall([DATE], { maxFollowUps: 3, followUpContacts: [] });
    await sweep(later(0));
    expect(await placed()).toHaveLength(1);
  });

  it('rings once for all due dates, in the row\'s call style', async () => {
    await readyForCall([DATE, '2026-08-18'], { maxFollowUps: 3, followUpContacts: rowsOf(['whatsapp', 'voice', 'voice'], 'agent') });
    expect((await sweep(later(0))).called).toBe(1);
    const [call] = await placed();
    expect(call).toMatchObject({ purpose: 'follow_up', provider: 'livekit' });
    const rows = await withTenant(scenario.tenantId, (tx) => tx.select().from(cases));
    expect(rows.map((r) => r.followUpCount)).toEqual([2, 2]);
  });
});
