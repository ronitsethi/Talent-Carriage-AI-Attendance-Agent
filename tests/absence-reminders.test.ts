import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { absenceEscalations, cases, employees, jobs } from '@/db/schema';
import { handleInbound, type TenantSettings } from '@/lib/conversation/engine';
import { askGroup, inWorkingHours, unansweredCases } from '@/lib/conversation/absence-group';
import { escalationSelectionId, runAbsenceWatch } from '@/lib/conversation/absence-reminders';
import {
  ABSENT_ESCALATED_TEMPLATE,
  ABSENT_REMINDER_TEMPLATE,
  MANAGER_NO_RESPONSE_TEMPLATE,
} from '@/lib/conversation/absence-templates';
import { runDailyCheck } from '@/lib/detection/run';
import { sheetSelectionId } from '@/lib/conversation/sheet';
import type { FullContext } from '@/lib/runtime';
import { giveAttendance, makeScenario, tapOption, type Scenario } from './helpers/scenario';

/**
 * Reminders for an ignored first message, and the manager after enough of them
 * or enough days - on the clock, whatever the uploads do.
 */

let scenario: Scenario;
let managerMobile: string;
afterEach(async () => {
  await scenario?.cleanup();
});

const DAY = 86_400_000;
/** 10:30 in the morning in India: inside working hours. */
const T0 = new Date('2026-11-02T05:00:00Z');
const after = (days: number) => new Date(T0.getTime() + days * DAY);

/** Two absences asked about together at T0 and ignored, for someone on automatic with a manager. */
async function ignored(settings: Partial<TenantSettings> = {}) {
  scenario = await makeScenario({ operatingMode: 'automatic', reminderIntervalDays: 3, remindersBeforeEscalation: 2, ...settings });
  managerMobile = `9180000${Math.floor(Math.random() * 90000) + 10000}`;
  await withTenant(scenario.tenantId, async (tx) => {
    await tx.insert(employees).values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile });
    await tx.update(employees).set({ managerMobileE164: managerMobile }).where(eq(employees.id, scenario.employeeId));
    const dates = ['2026-10-29', '2026-10-30'];
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, dates.map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A' })));
    for (const date of dates) await runDailyCheck(scenario.context(tx), { date, trigger: 'manual', createOnly: true });
    const ctx = { ...scenario.context(tx), now: () => T0 };
    const employee = (await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }))!;
    await askGroup(ctx, employee, await unansweredCases(ctx, scenario.employeeId), 'first');
  });
  scenario.channel.clear();
}

const inTenant = <T>(fn: (tx: Db) => Promise<T>) => withTenant(scenario.tenantId, fn);
const watch = (at: Date) => inTenant((tx) => runAbsenceWatch(scenario.context(tx) as FullContext, scenario.employeeId, at));
const sent = () => scenario.channel.history().map((s) => s.message as { to: string; templateName?: string; variables?: string[]; buttonPayloads?: string[] });
const employeeRow = () => inTenant((tx) => tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }).then((row) => row!));
const allCases = () => inTenant((tx) => tx.select().from(cases).where(eq(cases.employeeId, scenario.employeeId)).orderBy(asc(cases.attDate)));
const watches = () =>
  inTenant((tx) => tx.select({ runAt: jobs.runAt }).from(jobs).where(and(eq(jobs.kind, 'absence_watch'), eq(jobs.tenantId, scenario.tenantId))).orderBy(asc(jobs.runAt)));

describe('the reminder clock', () => {
  it('books the first check the interval after the message', async () => {
    await ignored();
    expect((await watches()).map((w) => w.runAt.toISOString())).toEqual([after(3).toISOString()]);
  });

  it('never wakes anyone at night: it waits for ten in the morning', () => {
    // 11 pm in India is 17:30 UTC; ten the next morning is 04:30 UTC.
    expect(inWorkingHours(new Date('2026-11-05T17:30:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-11-06T04:30:00.000Z');
    expect(inWorkingHours(new Date('2026-11-05T06:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-11-05T06:00:00.000Z');
  });

  it('does nothing before it is due, and reminds with every date once it is', async () => {
    await ignored();
    expect(await watch(after(1))).toMatchObject({ skipped: 'not due yet' });
    expect(sent()).toHaveLength(0);

    expect(await watch(after(3))).toMatchObject({ reminded: 'whatsapp', dates: 2 });
    const [reminder] = sent();
    expect(reminder!.templateName).toBe(ABSENT_REMINDER_TEMPLATE);
    expect(reminder!.variables![1]).toBe('29-Oct-2026 and 30-Oct-2026');
    expect((await employeeRow()).absenceReminders).toBe(1);
  });

  it('starts again from a new absence message, which does not count as a reminder', async () => {
    await ignored();
    // A new absence message on day 2 moves the clock to day 5.
    await inTenant((tx) => tx.update(employees).set({ absenceContactAt: after(2) }).where(eq(employees.id, scenario.employeeId)));
    expect(await watch(after(3))).toMatchObject({ skipped: 'not due yet' });
    expect(await watch(after(5))).toMatchObject({ reminded: 'whatsapp' });
    expect((await employeeRow()).absenceReminders).toBe(1);
  });

  it('leaves someone on Manual to HR', async () => {
    await ignored();
    await inTenant((tx) => tx.update(employees).set({ operatingMode: 'manual' }).where(eq(employees.id, scenario.employeeId)));
    expect(await watch(after(3))).toMatchObject({ skipped: 'manual: HR sends reminders from the dashboard' });
    expect(sent()).toHaveLength(0);
  });

  it('stops counting once they answer', async () => {
    await ignored();
    await watch(after(3));
    const [lead] = await allCases();
    const button = sent()[0]!.buttonPayloads![2]!;
    // "I was on leave", then "Not applied yet": both dates answered.
    await inTenant((tx) => handleInbound(scenario.context(tx), tapOption(scenario.mobile, button)));
    await inTenant((tx) => handleInbound(scenario.context(tx), tapOption(scenario.mobile, sheetSelectionId(lead!.id, 'leave_not'))));
    expect((await employeeRow()).absenceReminders).toBe(0);
    expect(lead).toBeDefined();
  });
});

describe('escalating to the manager', () => {
  it('after the set number of reminders: the employee is warned and the manager is asked', async () => {
    await ignored({ remindersBeforeEscalation: 1 });
    await watch(after(3));
    scenario.channel.clear();
    // The time for a second reminder: the one allowed has gone, so the manager is told instead.
    expect(await watch(after(6))).toMatchObject({ escalated: 'manager', dates: 2 });

    const toEmployee = sent().filter((m) => m.to === scenario.mobile);
    expect(toEmployee.map((m) => m.templateName)).toEqual([ABSENT_ESCALATED_TEMPLATE]);
    expect(toEmployee[0]!.variables).toEqual(['Ankit', '29-Oct-2026 and 30-Oct-2026', 'your manager, Deepak']);

    const toManager = sent().filter((m) => m.to === managerMobile);
    expect(toManager.map((m) => m.templateName)).toEqual([MANAGER_NO_RESPONSE_TEMPLATE]);
    expect(toManager[0]!.variables).toEqual(['Ankit Panwar (E-1)', '29-Oct-2026 and 30-Oct-2026']);
    expect((await allCases()).map((r) => r.status)).toEqual(['escalated', 'escalated']);
  });

  it('after the set number of days, however few reminders went', async () => {
    await ignored({ reminderIntervalDays: 0, escalateAfterDays: 5 });
    expect(await watch(after(4))).toMatchObject({ skipped: 'not due yet' });
    expect(await watch(after(5))).toMatchObject({ escalated: 'manager' });
  });

  it("closes the dates as Loss of Pay when the manager says so, and tells the employee", async () => {
    await ignored({ reminderIntervalDays: 0, escalateAfterDays: 5 });
    await watch(after(5));
    const [escalation] = await inTenant((tx) => tx.select().from(absenceEscalations).where(eq(absenceEscalations.employeeId, scenario.employeeId)));
    scenario.channel.clear();

    await inTenant((tx) => handleInbound(scenario.context(tx), tapOption(managerMobile, escalationSelectionId(escalation!.id, 'lop'))));
    expect((await allCases()).map((r) => [r.status, r.closeReason])).toEqual([
      ['resolved', 'Marked Loss of Pay by Deepak Gajjar after no reply'],
      ['resolved', 'Marked Loss of Pay by Deepak Gajjar after no reply'],
    ]);
    expect(sent().some((m) => m.to === scenario.mobile)).toBe(true);
  });

  it('keeps the dates with the manager when they will speak to the employee', async () => {
    await ignored({ reminderIntervalDays: 0, escalateAfterDays: 5 });
    await watch(after(5));
    const [escalation] = await inTenant((tx) => tx.select().from(absenceEscalations).where(eq(absenceEscalations.employeeId, scenario.employeeId)));
    await inTenant((tx) => handleInbound(scenario.context(tx), tapOption(managerMobile, escalationSelectionId(escalation!.id, 'speak'))));
    const rows = await allCases();
    expect(rows.map((r) => [r.status, r.needsHrReason])).toEqual([
      ['escalated', 'Deepak Gajjar will speak to them'],
      ['escalated', 'Deepak Gajjar will speak to them'],
    ]);
    // Nothing more goes to the employee about them.
    expect(await watch(after(9))).toMatchObject({ skipped: 'nothing unanswered' });
  });
});
