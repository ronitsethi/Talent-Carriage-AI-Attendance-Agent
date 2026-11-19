import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { absenceEscalations, calls, cases, employees } from '@/db/schema';
import { handleInbound, type TenantSettings } from '@/lib/conversation/engine';
import { contactPerson } from '@/lib/conversation/daily-contact';
import { handlers } from '@/lib/jobs/handlers';
import { scheduleDueWork } from '@/lib/jobs/scheduler';
import { escalationSelectionId } from '@/lib/conversation/absence-reminders';
import {
  ABSENT_ESCALATED_TEMPLATE,
  ABSENT_LAST_WARNING_TEMPLATE,
  ABSENT_REMINDER_FIRM_TEMPLATE,
  ABSENT_REMINDER_TEMPLATE,
  MANAGER_NO_RESPONSE_TEMPLATE,
} from '@/lib/conversation/absence-templates';
import { recordNoAnswer } from '@/lib/voice/session';
import type { FullContext } from '@/lib/runtime';
import { makeScenario, tapOption, typeText, type Scenario } from './helpers/scenario';

/**
 * Reminders for dates nobody answered, counted per date, one message a day for
 * all of a person's dates, and the call rule. Fixed weekdays in November 2026,
 * mid-morning in India; every value is made up.
 */

let scenario: Scenario;
let managerMobile: string;
afterEach(async () => {
  await scenario?.cleanup();
});

const on = (date: string) => new Date(`${date}T05:00:00Z`);
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const NEXT_MON = '2026-11-09';

type Sent = { to: string; templateName?: string; variables?: string[]; buttonPayloads?: string[] };
const all = () => scenario.channel.history().map((s) => s.message as unknown as Sent);
const toEmployee = () => all().filter((m) => m.to === scenario.mobile);
const toManager = () => all().filter((m) => m.to === managerMobile);
const inTenant = <T>(fn: (tx: Db) => Promise<T>) => withTenant(scenario.tenantId, fn);
const ctxOf = (tx: Db) => scenario.context(tx) as FullContext;
const employeeRow = (tx: Db) => tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) }).then((row) => row!);
const allCases = () => inTenant((tx) => tx.select().from(cases).where(eq(cases.employeeId, scenario.employeeId)).orderBy(asc(cases.attDate)));

/** Someone on automatic with a manager. */
async function person(settings: Partial<TenantSettings> = {}) {
  scenario = await makeScenario({ operatingMode: 'automatic', reminderIntervalDays: 1, remindersBeforeEscalation: 3, ...settings });
  managerMobile = `9180000${Math.floor(Math.random() * 90000) + 10000}`;
  await inTenant(async (tx) => {
    await tx.insert(employees).values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile });
    await tx.update(employees).set({ managerMobileE164: managerMobile }).where(eq(employees.id, scenario.employeeId));
  });
}

/** A date asked (its first question sent) on `askedOn`, not answered. */
const asked = (attDate: string, askedOn: string) =>
  inTenant((tx) =>
    tx.insert(cases).values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate, meaning: 'absent_full', status: 'asked', askedAt: on(askedOn) }),
  );

/** Reminder rows: Reminder 1 on WhatsApp, the rest calls in `style`. */
const callsFrom2 = (count: number, style: 'keypad' | 'agent' = 'keypad') =>
  Array.from({ length: count }, (_, i) => ({ channel: i === 0 ? ('whatsapp' as const) : ('voice' as const), callMode: style }));

/** One person's reminders on a working day, as an upload's send carries them. */
const remind = (date: string) => inTenant(async (tx) => contactPerson(ctxOf(tx), await employeeRow(tx), on(date), { fresh: false, followUps: false }));

describe('reminders, counted per date', () => {
  it('go every working day, firmer after the first, warn at the last, then the manager', async () => {
    // Every row WhatsApp: by the third, two ignored reminders would otherwise ring.
    await person({ remindersBeforeEscalation: 3, reminderContacts: callsFrom2(3).map((row) => ({ ...row, channel: 'whatsapp' as const })) });
    await asked('2026-10-30', MON);

    await remind(TUE);
    await remind(WED);
    await remind(THU);
    expect(toEmployee().map((m) => m.templateName)).toEqual([ABSENT_REMINDER_TEMPLATE, ABSENT_REMINDER_FIRM_TEMPLATE, ABSENT_LAST_WARNING_TEMPLATE]);
    expect(toEmployee()[2]!.variables).toEqual(['Ankit', '30-Oct-2026', '30-Oct-2026', 'your manager, Deepak']);
    expect((await allCases())[0]!.reminderCount).toBe(3);

    // Out of reminders: the manager, and the employee is told it has gone to them.
    await remind(FRI);
    expect(toManager().map((m) => m.templateName)).toEqual([MANAGER_NO_RESPONSE_TEMPLATE]);
    expect(toEmployee().at(-1)!.templateName).toBe(ABSENT_ESCALATED_TEMPLATE);
    expect((await allCases())[0]!.status).toBe('escalated');
  });

  it('counts each date on its own, all in one message a day', async () => {
    await person({ remindersBeforeEscalation: 5 });
    await asked('2026-10-30', MON);
    await asked('2026-11-02', TUE);
    await remind(WED);
    // One message for both: the first date's second reminder, the second's first.
    expect(toEmployee()).toHaveLength(1);
    expect(toEmployee()[0]!.variables![1]).toBe('30-Oct-2026 and 02-Nov-2026');
    expect((await allCases()).map((r) => r.reminderCount)).toEqual([1, 1]);
    await remind(THU);
    expect((await allCases()).map((r) => r.reminderCount)).toEqual([2, 2]);
  });

  it("on an upload day go with the send: a new date's first question and the old date's reminder, in one message", async () => {
    await person({ remindersBeforeEscalation: 5 });
    await asked('2026-10-30', MON);
    await inTenant((tx) =>
      tx.insert(cases).values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate: '2026-11-02', meaning: 'absent_full', status: 'queued' }),
    );
    await inTenant(async (tx) => contactPerson(ctxOf(tx), await employeeRow(tx), on(TUE), { fresh: true, followUps: true }));
    expect(toEmployee()).toHaveLength(1);
    expect(toEmployee()[0]!.variables![1]).toBe('30-Oct-2026 and 02-Nov-2026');
    // The old date had its first reminder; the new one only its first question.
    expect((await allCases()).map((r) => [r.status, r.reminderCount])).toEqual([
      ['asked', 1],
      ['asked', 0],
    ]);
  });

  it('never goes twice a day, and waits over the weekend', async () => {
    await person();
    await asked('2026-10-30', THU);
    await remind(FRI);
    await remind(FRI);
    expect(toEmployee()).toHaveLength(1);
    // Saturday 7th is not a working day.
    expect(await remind('2026-11-07')).toMatchObject({ sent: 'nothing due' });
    await remind(NEXT_MON);
    expect((await allCases())[0]!.reminderCount).toBe(2);
  });

  it('keeps the gap "Remind after" sets', async () => {
    await person({ reminderIntervalDays: 2 });
    await asked('2026-10-30', MON);
    expect(await remind(TUE)).toMatchObject({ sent: 'nothing due' });
    await remind(WED);
    expect((await allCases())[0]!.reminderCount).toBe(1);
  });

  it('never go on a day with no upload, just like follow-ups', async () => {
    await person();
    await asked('2026-10-30', MON);
    // A whole working day on the clock, from morning to night: no reminder round is queued.
    for (const hour of ['03:30', '08:30', '12:30', '15:30']) {
      const { queued } = await scheduleDueWork(new Date(`${WED}T${hour}:00Z`));
      expect(queued.some((job) => /reminder_round|absence_watch|upload_contact/.test(job))).toBe(false);
    }
    // A round queued before this change does nothing when it runs.
    const leftover = await handlers.reminder_round({ tenantId: scenario.tenantId, payload: {} } as never);
    expect(leftover).toMatchObject({ skipped: expect.any(String) });
    expect(toEmployee()).toHaveLength(0);
    expect((await allCases())[0]!.reminderCount).toBe(0);
  });
});

describe('the call rule', () => {
  const placed = () => inTenant((tx) => tx.select().from(calls).where(eq(calls.employeeId, scenario.employeeId)));
  const ignored = (n: number) => inTenant((tx) => tx.update(employees).set({ ignoredContacts: n }).where(eq(employees.id, scenario.employeeId)));

  it('rings only at a reminder set to Call, in that row\'s call style, once enough were ignored', async () => {
    await person({ remindersBeforeEscalation: 5, reminderContacts: callsFrom2(5, 'agent') });
    await asked('2026-10-30', MON);
    await ignored(9);
    await remind(TUE);
    expect(await placed()).toHaveLength(0);
    expect(toEmployee()).toHaveLength(1);

    await remind(WED);
    const rung = await placed();
    expect(rung.map((c) => [c.purpose, c.provider])).toEqual([['first_contact', 'livekit']]);
    const [row] = await allCases();
    expect(row).toMatchObject({ reminderCount: 2, callsMade: 1 });
  });

  it('is WhatsApp while too few contacts were ignored, and after a call for the gap', async () => {
    await person({ remindersBeforeEscalation: 9, ignoredBeforeCall: 2, callGapDays: 2, reminderContacts: callsFrom2(9) });
    await asked('2026-10-30', MON);
    await remind(TUE); // 1st reminder: WhatsApp
    await ignored(1);
    await remind(WED); // only 1 ignored: WhatsApp
    expect(await placed()).toHaveLength(0);
    await ignored(2);
    await remind(THU); // a call
    expect(await placed()).toHaveLength(1);
    await remind(FRI); // within the 2-day gap: WhatsApp
    await remind(NEXT_MON);
    expect(await placed()).toHaveLength(1);
    await remind('2026-11-10'); // Tuesday: the gap has passed
    expect(await placed()).toHaveLength(2);
  });

  it('never rings at a reminder set to WhatsApp, even with every other condition met', async () => {
    const rows = callsFrom2(5);
    rows[1] = { channel: 'whatsapp', callMode: 'keypad' };
    await person({ remindersBeforeEscalation: 5, reminderContacts: rows });
    await asked('2026-10-30', MON);
    await inTenant((tx) => tx.update(cases).set({ reminderCount: 1, remindedAt: on(TUE) }).where(eq(cases.employeeId, scenario.employeeId)));
    await ignored(9);
    await remind(WED); // Reminder 2: its row says WhatsApp
    expect(await placed()).toHaveLength(0);
    expect(toEmployee()).toHaveLength(1);
    await remind(THU); // Reminder 3: Call
    expect(await placed()).toHaveLength(1);
  });

  it('by default rings only for the last warning', async () => {
    await person({ remindersBeforeEscalation: 3, reminderContacts: [] });
    await asked('2026-10-30', MON);
    await ignored(9);
    await remind(TUE);
    await remind(WED);
    expect(await placed()).toHaveLength(0);
    await remind(THU);
    expect(await placed()).toHaveLength(1);
  });

  it('one call covers a date at a WhatsApp level along with the one at a Call level', async () => {
    await person({ remindersBeforeEscalation: 5, reminderContacts: callsFrom2(5) });
    await asked('2026-10-29', MON);
    await asked('2026-10-30', MON);
    // 29 Oct is due its 2nd reminder (Call); 30 Oct its 1st (WhatsApp).
    await inTenant((tx) =>
      tx.update(cases).set({ reminderCount: 1, remindedAt: on(MON) }).where(and(eq(cases.employeeId, scenario.employeeId), eq(cases.attDate, '2026-10-29'))),
    );
    await ignored(9);
    await remind(TUE);
    expect(await placed()).toHaveLength(1);
    expect(toEmployee()).toHaveLength(0);
    expect((await allCases()).map((r) => [r.reminderCount, r.callsMade])).toEqual([
      [2, 1],
      [1, 1],
    ]);
  });

  it('sends the WhatsApp at once when the call rings out', async () => {
    await person({ remindersBeforeEscalation: 5, reminderContacts: callsFrom2(5) });
    await asked('2026-10-30', MON);
    await inTenant((tx) => tx.update(cases).set({ reminderCount: 1, remindedAt: on(TUE) }).where(eq(cases.employeeId, scenario.employeeId)));
    await ignored(5);
    await remind(WED);
    const [call] = await placed();
    scenario.channel.clear();
    await inTenant((tx) => recordNoAnswer(ctxOf(tx), call!.id, 'no_answer'));
    expect(toEmployee().map((m) => m.templateName)).toEqual([ABSENT_REMINDER_FIRM_TEMPLATE]);
  });

  it('starts counting ignored contacts again from any reply', async () => {
    await person();
    await asked('2026-10-30', MON);
    await ignored(4);
    await inTenant((tx) => handleInbound(ctxOf(tx), typeText(scenario.mobile, 'hello')));
    expect((await inTenant(employeeRow)).ignoredContacts).toBe(0);
  });
});

describe('the manager, when the reminders run out', () => {
  async function escalated() {
    await person({ remindersBeforeEscalation: 1 });
    await asked('2026-10-30', MON);
    await remind(TUE);
    await remind(WED);
    const [escalation] = await inTenant((tx) => tx.select().from(absenceEscalations).where(eq(absenceEscalations.employeeId, scenario.employeeId)));
    scenario.channel.clear();
    return escalation!;
  }

  it('closes the dates as Loss of Pay when the manager says so, and tells the employee', async () => {
    const escalation = await escalated();
    await inTenant((tx) => handleInbound(ctxOf(tx), tapOption(managerMobile, escalationSelectionId(escalation.id, 'lop'))));
    expect((await allCases()).map((r) => [r.status, r.closeReason])).toEqual([['resolved', 'Marked Loss of Pay by Deepak Gajjar after no reply']]);
    expect(toEmployee()).toHaveLength(1);
  });

  it('keeps the dates with the manager when they will speak to the employee', async () => {
    const escalation = await escalated();
    await inTenant((tx) => handleInbound(ctxOf(tx), tapOption(managerMobile, escalationSelectionId(escalation.id, 'speak'))));
    expect((await allCases()).map((r) => [r.status, r.needsHrReason])).toEqual([['escalated', 'Deepak Gajjar will speak to them']]);
    // Nothing more goes to the employee about it as a reminder.
    expect(await remind(FRI)).toMatchObject({ sent: 'nothing due' });
  });
});
