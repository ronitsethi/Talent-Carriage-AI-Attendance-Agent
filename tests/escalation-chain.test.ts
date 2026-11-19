import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { absenceEscalations, approvals, calls, cases, employees } from '@/db/schema';
import { addWorkingDays, isWorkingDay, today } from '@/lib/dates';
import { handleInbound, type TenantSettings } from '@/lib/conversation/engine';
import { handleFollowUpResponse, sendDueFollowUps } from '@/lib/conversation/followup';
import { decideEscalation, escalateAbsences, runManagerSteps } from '@/lib/conversation/absence-reminders';
import { HR_ALERT_TEMPLATE, payrollCutoff, sendHrSummary } from '@/lib/hr';
import type { FullContext } from '@/lib/runtime';
import { makeScenario, tapOption, type Scenario } from './helpers/scenario';

/**
 * The follow-ups and the chain after them, as the one-page rules have it:
 * working days only, one WhatsApp for all of a person's follow-up dates, and
 * the manager - a WhatsApp, a call if it is ignored, then HR. Every value here
 * is made up.
 */

let scenario: Scenario;
let managerMobile: string;
const HR_MOBILE = '919800000001';
afterEach(async () => {
  await scenario?.cleanup();
});

const DAY = 86_400_000;
/** So many days from now, moved on to a working day. */
const later = (days: number) => {
  let at = new Date(Date.now() + days * DAY);
  while (!isWorkingDay(today('Asia/Kolkata', at), { saturdayWorking: false })) at = new Date(at.getTime() + DAY);
  return at;
};
/** The next Sunday from now, mid-morning in India. */
const nextSunday = () => {
  let at = new Date(Date.now() + DAY);
  while (new Date(`${today('Asia/Kolkata', at)}T00:00:00Z`).getUTCDay() !== 0) at = new Date(at.getTime() + DAY);
  return new Date(`${today('Asia/Kolkata', at)}T05:00:00Z`);
};

type Sent = { to: string; body?: string; templateName?: string; variables?: string[]; buttonPayloads?: string[]; kind: string };
const all = () => scenario.channel.history().map((s) => s.message as unknown as Sent);
const toEmployee = () => all().filter((m) => m.to === scenario.mobile);
const toManager = () => all().filter((m) => m.to === managerMobile);
const toHr = () => all().filter((m) => m.to === HR_MOBILE);
const inTenant = <T>(fn: (tx: Db) => Promise<T>) => withTenant(scenario.tenantId, fn);
const ctxOf = (tx: Db) =>
  ({ ...scenario.context(tx), hooks: { onFollowUpResponse: async (...args: Parameters<typeof handleFollowUpResponse>) => void (await handleFollowUpResponse(...args)) } }) as FullContext;
const allCases = () => inTenant((tx) => tx.select().from(cases).where(eq(cases.employeeId, scenario.employeeId)).orderBy(asc(cases.attDate)));
const employeeRow = (tx: Db) => tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }).then((row) => row!);

/** A manager in the file, and an HR contact in Settings. */
async function setUp(settings: Partial<TenantSettings> = {}) {
  scenario = await makeScenario({ hrName: 'Priya Shah', hrMobileE164: HR_MOBILE, ...settings });
  managerMobile = `9180000${Math.floor(Math.random() * 90000) + 10000}`;
  await inTenant(async (tx) => {
    await tx.insert(employees).values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile });
    await tx.update(employees).set({ managerMobileE164: managerMobile }).where(eq(employees.id, scenario.employeeId));
  });
}

/** Dates answered "unwell, leave, not applied yet", each due its follow-up. */
async function answered(dates: string[]) {
  await inTenant(async (tx) => {
    for (const attDate of dates) {
      await tx.insert(cases).values({
        tenantId: scenario.tenantId,
        employeeId: scenario.employeeId,
        attDate,
        meaning: 'absent_full',
        status: 'answered',
        replyOption: 1,
        answeredAt: new Date(Date.now() - 2 * DAY),
        followUpDueAt: new Date(Date.now() - 1000),
        context: { outcome: { code: 'absent_unwell', leaveChoice: 'leave' } },
      });
    }
  });
}

describe('working days', () => {
  it('are Monday to Friday, and Saturday when ticked', () => {
    expect(isWorkingDay('2026-11-14', { saturdayWorking: false })).toBe(false); // Saturday
    expect(isWorkingDay('2026-11-14', { saturdayWorking: true })).toBe(true);
    expect(isWorkingDay('2026-11-15', { saturdayWorking: true })).toBe(false); // Sunday
    // Friday + 1 working day: Monday, or Saturday when it is worked.
    expect(addWorkingDays('2026-11-13', 1, { saturdayWorking: false })).toBe('2026-11-16');
    expect(addWorkingDays('2026-11-13', 1, { saturdayWorking: true })).toBe('2026-11-14');
  });

  it('send no follow-up on a day off', async () => {
    await setUp({ maxFollowUps: 3 });
    await answered(['2026-11-03']);
    const result = await inTenant((tx) => sendDueFollowUps(ctxOf(tx), nextSunday()));
    expect(result).toMatchObject({ due: 0, skipped: ['Not a working day'] });
    expect(all()).toHaveLength(0);
  });
});

describe('follow-ups on WhatsApp', () => {
  it('go as one message for all of a person, and one tap answers them all', async () => {
    await setUp({ maxFollowUps: 3 });
    await answered(['2026-11-03', '2026-11-04']);
    await inTenant((tx) => sendDueFollowUps(ctxOf(tx), later(0)));

    const messages = toEmployee();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.variables![1]).toBe('Reminder: you still need to apply leave for 03-Nov-2026 and 04-Nov-2026. Have you done it?');
    expect((await allCases()).map((r) => r.followUpCount)).toEqual([1, 1]);

    await inTenant((tx) => handleInbound(ctxOf(tx), tapOption(scenario.mobile, messages[0]!.buttonPayloads![1]!)));
    expect((await allCases()).map((r) => r.followUpReply)).toEqual(['not_done', 'not_done']);
  });

  it('end with one final notice, and one manager request for every date', async () => {
    await setUp({ maxFollowUps: 1 });
    await answered(['2026-11-03', '2026-11-04']);
    await inTenant((tx) => sendDueFollowUps(ctxOf(tx), later(0)));

    expect(toEmployee().map((m) => m.templateName)).toEqual(['attendance_final_notice']);
    expect(toEmployee()[0]!.variables![2]).toBe('03-Nov-2026 and 04-Nov-2026');
    expect(toManager()).toHaveLength(1);
    expect(toManager()[0]!.variables![2]).toBe('03-Nov-2026 and 04-Nov-2026');
    expect((await allCases()).map((r) => r.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
  });

  it('go straight to HR at the end when set so, and the final notice says HR', async () => {
    await setUp({ maxFollowUps: 1, escalationRoute: 'hr' });
    await answered(['2026-11-03']);
    await inTenant((tx) => sendDueFollowUps(ctxOf(tx), later(0)));
    expect(toEmployee()[0]!.variables![3]).toBe('HR');
    expect(toManager()).toHaveLength(0);
    expect((await allCases())[0]!.status).toBe('needs_hr');
    expect(toHr().map((m) => m.templateName)).toEqual([HR_ALERT_TEMPLATE]);
  });
});

describe("the manager's steps", () => {
  it('a request ignored on WhatsApp brings a call; a call ignored brings HR', async () => {
    await setUp({ maxFollowUps: 1 });
    await answered(['2026-11-03']);
    await inTenant((tx) => sendDueFollowUps(ctxOf(tx), later(0)));
    const approval = async () => (await inTenant((tx) => tx.select().from(approvals)))[0]!;

    // Past the WhatsApp step's deadline: the manager is rung, whatever their Contact by.
    const first = await approval();
    await inTenant((tx) => runManagerSteps(ctxOf(tx), new Date(first.timeoutAt!.getTime() + 3_600_000)));
    const rung = await inTenant((tx) => tx.select().from(calls).where(eq(calls.toNumber, managerMobile)));
    expect(rung.map((c) => c.purpose)).toEqual(['manager_approval']);
    const second = await approval();
    expect(second.nudges).toBe(1);

    // Past the call step's deadline: HR, and the employee is told.
    scenario.channel.clear();
    await inTenant((tx) => runManagerSteps(ctxOf(tx), new Date(second.timeoutAt!.getTime() + 3_600_000)));
    expect((await approval()).decision).toBe('expired');
    expect((await allCases())[0]).toMatchObject({ status: 'needs_hr', needsHrReason: 'Deepak Gajjar did not respond' });
    expect(toEmployee()[0]!.variables![3]).toBe('It has now gone to HR, who will contact you.');
    expect(toHr()).toHaveLength(1);
  });

  it('works the same for someone who never answered, with its own call', async () => {
    await setUp();
    await inTenant(async (tx) => {
      await tx.insert(cases).values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate: '2026-11-03', meaning: 'absent_full', status: 'asked', askedAt: new Date() });
      const ctx = ctxOf(tx);
      await escalateAbsences(ctx, await employeeRow(tx), await tx.select().from(cases).where(eq(cases.employeeId, scenario.employeeId)), 'No reply');
    });
    const escalation = async () => (await inTenant((tx) => tx.select().from(absenceEscalations)))[0]!;
    expect((await allCases())[0]!.status).toBe('escalated');

    const first = await escalation();
    await inTenant((tx) => runManagerSteps(ctxOf(tx), new Date(first.nextStepAt!.getTime() + 3_600_000)));
    const rung = await inTenant((tx) => tx.select().from(calls).where(eq(calls.toNumber, managerMobile)));
    expect(rung.map((c) => c.purpose)).toEqual(['manager_escalation']);

    const second = await escalation();
    await inTenant((tx) => runManagerSteps(ctxOf(tx), new Date(second.nextStepAt!.getTime() + 3_600_000)));
    expect((await allCases())[0]!.status).toBe('needs_hr');
  });

  it('"I\'ll speak to them" gives the employee working days, then HR if the file still shows it', async () => {
    await setUp({ speakGraceDays: 1 });
    await inTenant(async (tx) => {
      await tx.insert(cases).values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate: '2026-11-03', meaning: 'absent_full', status: 'asked', askedAt: new Date() });
      await escalateAbsences(ctxOf(tx), await employeeRow(tx), await tx.select().from(cases).where(eq(cases.employeeId, scenario.employeeId)), 'No reply');
    });
    const [esc] = await inTenant((tx) => tx.select().from(absenceEscalations));
    const decidedOn = later(0);
    scenario.channel.clear();
    await inTenant((tx) => decideEscalation(ctxOf(tx), esc!.id, 'speak', managerMobile, decidedOn));

    const after = (await inTenant((tx) => tx.select().from(absenceEscalations)))[0]!;
    expect(after.speakUntil).toBe(addWorkingDays(today('Asia/Kolkata', decidedOn), 1, { saturdayWorking: false }));
    expect(toEmployee()[0]!.variables![3]).toContain('Your manager, Deepak, will speak to you about it.');

    await inTenant((tx) => runManagerSteps(ctxOf(tx), new Date(after.nextStepAt!.getTime() + 3_600_000)));
    expect((await allCases())[0]).toMatchObject({ status: 'needs_hr', needsHrReason: 'Deepak Gajjar was to speak to them, and it is still not sorted' });
  });
});

describe('HR', () => {
  it('gets a daily summary of what is waiting, urgent near the payroll cut-off', async () => {
    await setUp();
    await inTenant(async (tx) => {
      await tx.insert(cases).values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate: '2026-11-03', meaning: 'absent_full', status: 'needs_hr' });
      await sendHrSummary(ctxOf(tx), later(0));
    });
    expect(toHr()[0]!.variables).toEqual(['Priya', '1 attendance date is waiting on you, for 1 person.']);
  });

  it('marks dates urgent from 2 working days before the cut-off', () => {
    const settings = { payrollCutoffDay: 25, saturdayWorking: false } as FullContext['settings'];
    expect(payrollCutoff(settings, '2026-11-20')).toEqual({ cutoff: '2026-11-25', urgent: false }); // Friday
    expect(payrollCutoff(settings, '2026-11-23')).toEqual({ cutoff: '2026-11-25', urgent: true }); // Monday
    expect(payrollCutoff(settings, '2026-11-26')).toEqual({ cutoff: '2026-12-25', urgent: false });
    expect(payrollCutoff({ ...settings, payrollCutoffDay: null }, '2026-11-23')).toBeNull();
  });
});

