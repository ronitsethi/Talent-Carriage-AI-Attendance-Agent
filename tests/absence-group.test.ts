import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { actions, approvals, cases, employees } from '@/db/schema';
import { handleInbound, type EngineHooks } from '@/lib/conversation/engine';
import { sortDates, type ChatVerdict } from '@/lib/conversation/talk';
import { approvalSelectionId, selectionId } from '@/lib/conversation/flow';
import { sheetSelectionId } from '@/lib/conversation/sheet';
import { askGroup, unansweredCases } from '@/lib/conversation/absence-group';
import { ABSENT_GROUP_TEMPLATE, ABSENT_REMINDER_TEMPLATE } from '@/lib/conversation/absence-templates';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, tapOption, typeText, type Scenario } from './helpers/scenario';

/**
 * Asking about absences once per person: every unanswered date in one message,
 * a button answering all of them, and one manager request for the lot.
 */

let scenario: Scenario;
let managerMobile: string;
afterEach(async () => {
  await scenario?.cleanup();
});

const DATES = ['2026-08-17', '2026-08-18', '2026-08-20'];

/** Three absent dates, made into cases without anything sent, and a manager named by mobile. */
async function threeAbsences() {
  scenario = await makeScenario();
  managerMobile = `9180000${Math.floor(Math.random() * 90000) + 10000}`;
  await withTenant(scenario.tenantId, async (tx) => {
    await tx.insert(employees).values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile });
    await tx.update(employees).set({ managerMobileE164: managerMobile }).where(eq(employees.id, scenario.employeeId));
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, DATES.map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A|A' })));
    for (const date of DATES) await runDailyCheck(scenario.context(tx), { date, trigger: 'manual', createOnly: true });
  });
  scenario.channel.clear();
}

const inTenant = <T>(fn: (tx: Db) => Promise<T>) => withTenant(scenario.tenantId, fn);
const employeeRow = (tx: Db) => tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }).then((row) => row!);
const allCases = (tx: Db) => tx.select().from(cases).where(eq(cases.employeeId, scenario.employeeId)).orderBy(asc(cases.attDate));
const sent = () => scenario.channel.history().map((s) => s.message as { kind: string; templateName?: string; variables?: string[]; buttonPayloads?: string[]; body?: string; to: string });

/** The button a message actually carries for an option, as the employee would tap it. */
const buttonFor = (option: 1 | 2 | 3 | 4) => {
  const message = sent().find((m) => m.buttonPayloads)!;
  return message.buttonPayloads![option - 1]!;
};

async function askAll(kind: 'first' | 'reminder' = 'first') {
  return inTenant(async (tx) => {
    const ctx = scenario.context(tx);
    const rows = await unansweredCases(ctx, scenario.employeeId);
    return askGroup(ctx, await employeeRow(tx), rows, kind);
  });
}

const tap = (selection: string, from = scenario.mobile) => inTenant((tx) => handleInbound(scenario.context(tx), tapOption(from, selection)));

describe('one message for every unanswered date', () => {
  it('lists every date in one template, with buttons that lead with the oldest', async () => {
    await threeAbsences();
    const result = await askAll();
    expect(result.sent).toBe(true);

    const messages = sent();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message!.templateName).toBe(ABSENT_GROUP_TEMPLATE);
    expect(message!.variables).toEqual(['Ankit', '17-Aug-2026, 18-Aug-2026 and 20-Aug-2026']);

    const rows = await inTenant(allCases);
    expect(rows.map((r) => r.status)).toEqual(['asked', 'asked', 'asked']);
    expect(message!.buttonPayloads![0]).toMatch(new RegExp(`^g2:${rows[0]!.id}:[0-9a-f-]{36}:1$`));
    const employee = await inTenant(employeeRow);
    expect(employee.absenceContactAt).not.toBeNull();
  });

  it('reminds with its own template, naming the same dates', async () => {
    await threeAbsences();
    await askAll();
    scenario.channel.clear();
    await askAll('reminder');
    const [message] = sent();
    expect(message!.templateName).toBe(ABSENT_REMINDER_TEMPLATE);
    expect(message!.variables![1]).toBe('17-Aug-2026, 18-Aug-2026 and 20-Aug-2026');
  });

  it('asks a single date the way it always has', async () => {
    await threeAbsences();
    await inTenant(async (tx) => {
      const ctx = scenario.context(tx);
      const [first] = await unansweredCases(ctx, scenario.employeeId);
      await askGroup(ctx, await employeeRow(tx), [first!], 'first');
    });
    const [message] = sent();
    expect(message!.templateName).toBe('attendance_absent_check');
    expect(message!.variables![1]).toBe('17-Aug-2026');
  });
});

describe('a button answers every date it listed', () => {
  it('answers only its own date when it was on an earlier message about that date alone', async () => {
    await threeAbsences();
    const [first] = await inTenant(allCases);
    // The 17th asked alone, then everything together.
    await inTenant(async (tx) => {
      const ctx = scenario.context(tx);
      await askGroup(ctx, await employeeRow(tx), [first!], 'first');
    });
    await askAll();
    await tap(selectionId(first!.id, 1));
    await tap(sheetSelectionId(first!.id, 'unwell'));
    await tap(sheetSelectionId(first!.id, 'lop'));
    const rows = await inTenant(allCases);
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'asked', 'asked']);
  });

  it('asks what happened once, for all of them, and Loss of Pay closes each one', async () => {
    await threeAbsences();
    await askAll();
    const [lead] = await inTenant(allCases);
    const button = buttonFor(1);
    scenario.channel.clear();

    await tap(button);
    const menu = sent().at(-1)!;
    expect(menu.body).toContain('17-Aug-2026, 18-Aug-2026 and 20-Aug-2026');

    await tap(sheetSelectionId(lead!.id, 'unwell'));
    await tap(sheetSelectionId(lead!.id, 'lop'));
    const rows = await inTenant(allCases);
    expect(rows.map((r) => [r.status, r.closeReason])).toEqual([
      ['resolved', 'Employee chose Loss of Pay'],
      ['resolved', 'Employee chose Loss of Pay'],
      ['resolved', 'Employee chose Loss of Pay'],
    ]);
  });

  it('sends the manager one request for every date, and the decision closes them all', async () => {
    await threeAbsences();
    await askAll();
    const [lead] = await inTenant(allCases);

    await tap(buttonFor(3));
    await tap(sheetSelectionId(lead!.id, 'leave_done'));

    const rows = await inTenant(allCases);
    expect(rows.map((r) => r.status)).toEqual(['awaiting_approval', 'awaiting_approval', 'awaiting_approval']);
    const toManager = sent().filter((m) => m.to === managerMobile);
    expect(toManager).toHaveLength(1);
    expect(toManager[0]!.variables![2]).toBe('17-Aug-2026, 18-Aug-2026 and 20-Aug-2026');

    const [approval] = await inTenant((tx) =>
      tx.select({ id: approvals.id, covers: approvals.covers }).from(approvals).innerJoin(actions, eq(actions.id, approvals.actionId)).where(eq(actions.caseId, lead!.id)),
    );
    expect(approval!.covers).toHaveLength(2);

    await tap(approvalSelectionId(approval!.id, 'approve'), managerMobile);
    const after = await inTenant(allCases);
    expect(after.map((r) => r.status)).toEqual(['resolved', 'resolved', 'resolved']);
    const told = await inTenant((tx) => tx.select().from(actions).where(and(eq(actions.employeeId, scenario.employeeId), eq(actions.status, 'approved'))));
    expect(told).toHaveLength(3);
  });

  it('answers the dates still open when the first was answered some other way', async () => {
    await threeAbsences();
    await askAll();
    const [lead, second] = await inTenant(allCases);
    // The first date is settled on its own, outside the group.
    await inTenant((tx) => tx.update(cases).set({ status: 'resolved' }).where(eq(cases.id, lead!.id)));

    await tap(buttonFor(1));
    await tap(sheetSelectionId(second!.id, 'unwell'));
    await tap(sheetSelectionId(second!.id, 'lop'));
    const rows = await inTenant(allCases);
    expect(rows.map((r) => r.closeReason)).toEqual([null, 'Employee chose Loss of Pay', 'Employee chose Loss of Pay']);
  });
});

/** A conversation that always comes to this verdict. */
const conversing = (verdict: Partial<ChatVerdict>): EngineHooks => ({
  converse: async () => ({ reply: 'Okay.', outcome: null, leaveChoice: null, application: null, note: null, action: 'continue', handoverReason: null, ...verdict }),
});

describe('one typed reply for several dates', () => {
  it('writes the same answer on the dates it was for, and a different one on another', async () => {
    await threeAbsences();
    await askAll();
    // "17th and 18th I was sick, take it as Loss of Pay. 20th was my weekly off."
    await inTenant((tx) =>
      handleInbound(
        { ...scenario.context(tx), hooks: conversing({
          outcome: 'absent_unwell',
          leaveChoice: 'loss_of_pay',
          sameDates: ['2026-08-18'],
          otherDates: [{ dates: ['2026-08-20'], outcome: 'weekly_off', leave_choice: 'not_said', application: 'not_said', note: null }],
        }) },
        typeText(scenario.mobile, '17th and 18th I was sick, take it as LOP. 20th was my weekly off'),
      ),
    );
    const rows = await inTenant(allCases);
    expect(rows.map((r) => [r.attDate, r.status, (r.context as { outcome?: { code: string } }).outcome?.code])).toEqual([
      ['2026-08-17', 'resolved', 'absent_unwell'],
      ['2026-08-18', 'resolved', 'absent_unwell'],
      // A weekly off is HR's to put right in the roster, as when it is answered alone.
      ['2026-08-20', 'needs_hr', 'weekly_off'],
    ]);
  });

  it('leaves a date it did not cover open, to be asked next', async () => {
    await threeAbsences();
    await askAll();
    await inTenant((tx) =>
      handleInbound(
        { ...scenario.context(tx), hooks: conversing({ outcome: 'absent_unwell', leaveChoice: 'loss_of_pay', sameDates: [] }) },
        typeText(scenario.mobile, 'I was sick on the 17th, LOP'),
      ),
    );
    const rows = await inTenant(allCases);
    expect(rows.map((r) => r.status)).toEqual(['resolved', 'asked', 'asked']);
    // The next question names the date still open.
    expect(sent().at(-1)!.body).toContain('18-Aug-2026');
  });
});

describe('what the conversation model says, sorted by code', () => {
  const base = { reply_language: 'en-IN' as const, reply: 'Okay.', action: 'continue' as const, leave_type: null, follow_up: 'none' as const, handover_reason: null, note: null };

  it('puts a date with the same answer with the discussed one, and a different answer on its own', () => {
    const sorted = sortDates(
      {
        ...base,
        outcome: 'leave_not_applied',
        leave_choice: 'not_said',
        application: 'not_said',
        per_date: [
          { date: '2026-11-03', outcome: 'leave_not_applied', leave_choice: 'not_said', application: 'not_said', note: null },
          { date: '2026-11-04', outcome: 'none', leave_choice: 'not_said', application: 'not_said', note: null },
          { date: '2026-11-05', outcome: 'leave_not_applied', leave_choice: 'not_said', application: 'not_said', note: null },
        ],
      },
      '2026-11-03',
    );
    expect(sorted.same_dates).toEqual(['2026-11-05']);
    expect(sorted.other_dates!.map((o) => [o.dates, o.outcome])).toEqual([[['2026-11-04'], 'none']]);
  });

  it("takes the discussed date's answer from its own line when the top fields left it unsaid", () => {
    const sorted = sortDates(
      { ...base, outcome: 'none', leave_choice: 'not_said', application: 'not_said', per_date: [{ date: '2026-11-03', outcome: 'absent_unwell', leave_choice: 'loss_of_pay', application: 'not_said', note: null }] },
      '2026-11-03',
    );
    expect(sorted.outcome).toBe('absent_unwell');
    expect(sorted.leave_choice).toBe('loss_of_pay');
  });
});

describe('"I was on leave" typed', () => {
  it('asks whether it is applied before telling them what to do, and leaves a date answered differently open', async () => {
    await threeAbsences();
    await askAll();
    scenario.channel.clear();
    // "Leave on the 17th, working on the 18th" - the 18th not yet enough to settle.
    await inTenant((tx) =>
      handleInbound(
        { ...scenario.context(tx), hooks: conversing({
          outcome: 'leave_not_applied',
          reply: 'Please apply leave for 17-Aug-2026 in the HRMS.',
          otherDates: [{ dates: ['2026-08-18'], outcome: 'none', leave_choice: 'not_said', application: 'not_said', note: null }],
        }) },
        typeText(scenario.mobile, 'I was on leave on 17th and was working on 18th'),
      ),
    );
    const [asked] = sent();
    expect(asked!.body).toBe('Okay. Have you applied leave for 17-Aug-2026 yet?');
    expect((await inTenant(allCases)).map((r) => r.status)).toEqual(['asked', 'asked', 'asked']);
  });
});
