import { afterEach, describe, expect, it } from 'vitest';
import { asc, desc, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { calls, cases, employees } from '@/db/schema';
import { runDailyCheck } from '@/lib/detection/run';
import { handleTurn, openingTurn, placeCaseCall } from '@/lib/voice/session';
import { sendDueFollowUps } from '@/lib/conversation/followup';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * Everything the caller hears in one turn.
 *
 * A turn is delivered in two pieces - what is said before the question, then
 * the question itself - so that a long preamble never eats into the seconds the
 * employee has to press a key. The employee hears one sentence either way.
 */
const heard = (turn: { intro?: string; speak: string }) => [turn.intro, turn.speak].filter(Boolean).join(' ');

/**
 * The call placed about one date.
 *
 * Rows come back from Postgres in no particular order, so a call has to be
 * asked for by what it is about rather than by where it happens to sit.
 */
async function callAbout(tx: Db, attDate: string) {
  const caseRow = await tx.query.cases.findFirst({ where: eq(cases.attDate, attDate) });
  const rows = await tx
    .select()
    .from(calls)
    .where(eq(calls.caseId, caseRow!.id))
    .orderBy(desc(calls.attempt));
  return rows[0]!;
}

/**
 * The agreed call behaviour, in the customer's own words:
 *
 *   "I was absent from 21st to 25th September. I got a call on 21st which I did
 *    not pick, and got one for everyday until 25th which I finally did pick. It
 *    is in this call in which I will get a summary after I am done with 25th."
 *
 * So: one call per absent date, no retries for missed ones, and the call that is
 * finally answered clears the whole backlog - starting with the date it rang
 * about, then the older ones.
 */

const DATES = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
let scenario: Scenario;

afterEach(async () => {
  await scenario?.cleanup();
});

async function absentAllWeek(settings = {}) {
  scenario = await makeScenario(
    { defaultChannel: 'voice', callerId: '+912269871077', ...settings },
    { preferredChannel: 'voice' },
  );
  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(
      tx,
      scenario.tenantId,
      scenario.employeeId,
      DATES.map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A' })),
    );
    // One run per day, as the scheduler would do - each about the previous day.
    for (const date of DATES) {
      await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
    }
  });
}

describe('one call per absent date', () => {
  it('rings once for each date and never retries a missed one', async () => {
    await absentAllWeek();

    expect(scenario.voice.history()).toHaveLength(5);
    expect(scenario.channel.history(), 'nothing should go to WhatsApp').toHaveLength(0);

    await withTenant(scenario.tenantId, async (tx) => {
      const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
      expect(rows.map((r) => r.channel)).toEqual(['voice', 'voice', 'voice', 'voice', 'voice']);
      expect(rows.every((r) => r.status === 'asked')).toBe(true);

      // Re-running the check adds nothing: no second call for the same date.
      for (const date of DATES) {
        const result = await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
        expect(result.messagesSent).toBe(0);
      }
    });
    expect(scenario.voice.history()).toHaveLength(5);
  });

  it('calls the employee, from the customer\'s number', async () => {
    await absentAllWeek();
    const first = scenario.voice.history()[0]!.request;
    expect(first.to).toBe(`+${scenario.mobile}`);
    expect(first.from).toBe('+912269871077');
    expect(first.answerUrl).toContain('/api/voice/answer?call=');
  });
});

describe('the call that is finally answered', () => {
  it('starts with the date it rang about, then sweeps the backlog', async () => {
    await absentAllWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      // The fifth call is about 25 September.
      const [call] = await tx
        .select()
        .from(calls)
        .orderBy(asc(calls.attempt), asc(calls.id));
      const latest = await callAbout(tx, '2026-09-25');
      expect(call).toBeDefined();

      const opening = await openingTurn(ctx, latest.id);
      expect(heard(opening)).toContain('5 days of attendance still to be confirmed');
      expect(heard(opening)).toContain('25 September');
      expect(opening.done).toBe(false);

      // Answer 25 September with "1 - I was absent".
      const afterFirst = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '1' });
      expect(heard(afterFirst)).toContain('Please apply leave for 25 September');
      expect(heard(afterFirst)).toContain('4 more days pending');
      expect(heard(afterFirst)).toContain('21 September'); // oldest next
      expect(afterFirst.done).toBe(false);

      // Work through the rest in the same call.
      let turn = afterFirst;
      const answeredDates: string[] = ['2026-09-25'];
      while (!turn.done && turn.nextCaseId) {
        const current = await tx.query.cases.findFirst({ where: eq(cases.id, turn.nextCaseId) });
        answeredDates.push(current!.attDate);
        turn = await handleTurn(ctx, latest.id, turn.nextCaseId, { digits: '2' });
      }

      expect(answeredDates).toEqual(['2026-09-25', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);
      expect(turn.speak).toContain('All 5 days are now confirmed');

      const rows = await tx.select().from(cases);
      expect(rows.every((r) => r.status === 'answered')).toBe(true);
      expect(rows.filter((r) => r.replyOption === 1)).toHaveLength(1);
      expect(rows.filter((r) => r.replyOption === 2)).toHaveLength(4);
    });
  });

  it('understands the employee speaking instead of pressing a key', async () => {
    await absentAllWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const latest = await callAbout(tx, '2026-09-25');
      const opening = await openingTurn(ctx, latest.id);

      // No key pressed; they just said it. Handled by the same classifier that
      // reads typed WhatsApp replies.
      const turn = await handleTurn(ctx, latest.id, opening.nextCaseId!, { speech: 'no I was working that day' });
      const answered = await tx.query.cases.findFirst({ where: eq(cases.id, opening.nextCaseId!) });
      expect(answered!.replyOption).toBe(2);
      expect(heard(turn)).toContain('regularisation');
    });
  });

  it('asks again once when it cannot tell, then hands over to HR', async () => {
    await absentAllWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const latest = await callAbout(tx, '2026-09-25');
      const opening = await openingTurn(ctx, latest.id);

      const first = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '9' });
      expect(first.retry).toBe(true);
      expect(heard(first)).toContain('did not catch that');

      const second = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '' });
      expect(second.done).toBe(true);
      expect(second.speak).toContain('HR team');
    });
  });

  it('keeps a transcript, so a call reads like a conversation in the portal', async () => {
    await absentAllWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const latest = await callAbout(tx, '2026-09-25');
      const opening = await openingTurn(ctx, latest.id);
      await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '1' });

      const row = await tx.query.calls.findFirst({ where: eq(calls.id, latest.id) });
      const roles = (row!.transcript ?? []).map((t) => t.role);
      expect(roles).toEqual(['agent', 'employee', 'agent']);
      expect(row!.transcript![1]!.text).toBe('pressed 1');
    });
  });
});

describe('channel choice', () => {
  it('sends WhatsApp for employees set to WhatsApp, and calls the rest', async () => {
    scenario = await makeScenario({ defaultChannel: 'whatsapp' }, { preferredChannel: 'whatsapp' });
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-09-21', meaning: 'absent_full', raw: 'A' },
      ]);
      await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'manual' });

      expect(scenario.channel.history()).toHaveLength(1);
      expect(scenario.voice.history()).toHaveLength(0);

      // Switch the employee to Call; the next date goes out as a call.
      await tx.update(employees).set({ preferredChannel: 'voice' }).where(eq(employees.id, scenario.employeeId));
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-09-22', meaning: 'absent_full', raw: 'A' },
      ]);
      await runDailyCheck(scenario.context(tx), { date: '2026-09-22', trigger: 'manual' });

      expect(scenario.channel.history()).toHaveLength(1);
      expect(scenario.voice.history()).toHaveLength(1);
    });
  });

  it('leaves manual employees alone on a scheduled run, and contacts automatic ones', async () => {
    scenario = await makeScenario({ defaultChannel: 'voice' }, { preferredChannel: 'voice', operatingMode: 'manual' });
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-09-21', meaning: 'absent_full', raw: 'A' },
      ]);

      const scheduled = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'schedule' });
      expect(scheduled.messagesSent).toBe(0);
      expect(scheduled.skipped.manual_employee).toBe(1);

      await tx.update(employees).set({ operatingMode: 'automatic' }).where(eq(employees.id, scenario.employeeId));
      const second = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'schedule' });
      expect(second.messagesSent).toBe(1);
    });
  });
});

describe('contacting several dates at once', () => {
  it('rings a person once, however many of their dates are ticked', async () => {
    await absentAllWeek();
    // absentAllWeek already placed one call per date, as the daily run would.
    const perDateCalls = scenario.voice.history().length;
    expect(perDateCalls).toBe(5);

    // Now the bulk path: five dates for one person, from the dashboard.
    scenario.voice.clear();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      // Mirrors what contactSelected does for a voice employee: one call, about
      // the newest date, which then sweeps the rest.
      await placeCaseCall(ctx, rows.at(-1)!, employee!);
    });
    expect(scenario.voice.history()).toHaveLength(1);
  });
});

/**
 * The day-2 reminder, on the phone.
 *
 *   "I tried calling followup but the call is still the exact same instead of
 *    what is supposed to be said at step 2 based on step 1 call reply."
 *
 * A second call must ask about the *action* the employee was given, not repeat
 * the question they have already answered.
 */
describe('the follow-up call', () => {
  async function answeredWeek() {
    await absentAllWeek();
    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const latest = await callAbout(tx, '2026-09-25');
      const opening = await openingTurn(ctx, latest.id);
      let turn = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '1' });
      while (!turn.done && turn.nextCaseId) {
        turn = await handleTurn(ctx, latest.id, turn.nextCaseId, { digits: '2' });
      }
    });
    scenario.voice.clear();
  }

  it('asks about the action given last time, not the absence again', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      const [oldest] = await tx.select().from(cases).orderBy(asc(cases.attDate));

      const placed = await placeCaseCall(ctx, oldest!, employee!);
      expect(placed.placed).toBe(true);

      const call = await tx.query.calls.findFirst({ where: eq(calls.id, placed.callId!) });
      expect(call!.purpose, 'an answered date is past its first question').toBe('follow_up');

      const opening = await openingTurn(ctx, placed.callId!);
      const said = heard(opening);
      expect(said).toContain('Last time');
      expect(said).toContain('21 September');
      expect(said).not.toContain('Press 1 if you were absent');
      expect(said).toContain('Press 1 if it is done');
    });
  });

  it('leaves the answered date answered, rather than asking it all over again', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      const [oldest] = await tx.select().from(cases).orderBy(asc(cases.attDate));
      await placeCaseCall(ctx, oldest!, employee!);

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, oldest!.id) });
      expect(after!.status).toBe('answered');
      expect(after!.replyOption).toBe(2);
    });
  });

  it('sweeps the other dates in the same call, like the first one does', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      const [oldest] = await tx.select().from(cases).orderBy(asc(cases.attDate));
      const placed = await placeCaseCall(ctx, oldest!, employee!);
      const opening = await openingTurn(ctx, placed.callId!);
      const checked: string[] = [];
      let turn = await handleTurn(ctx, placed.callId!, opening.nextCaseId!, { digits: '1' });
      checked.push(oldest!.attDate);
      while (!turn.done && turn.nextCaseId) {
        const current = await tx.query.cases.findFirst({ where: eq(cases.id, turn.nextCaseId) });
        checked.push(current!.attDate);
        turn = await handleTurn(ctx, placed.callId!, turn.nextCaseId, { digits: '1' });
      }

      expect(checked).toEqual(DATES);
      expect(heard(turn)).toContain('That is everything');

      const rows = await tx.select().from(cases);
      expect(rows.every((r) => r.status === 'resolved')).toBe(true);
      expect(rows.every((r) => r.followUpReply === 'done')).toBe(true);
    });
  });

  it('records "not done yet" and keeps the case open', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      const [oldest] = await tx.select().from(cases).orderBy(asc(cases.attDate));
      const placed = await placeCaseCall(ctx, oldest!, employee!);
      const opening = await openingTurn(ctx, placed.callId!);
      await handleTurn(ctx, placed.callId!, opening.nextCaseId!, { digits: '2' });

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, oldest!.id) });
      expect(after!.followUpReply).toBe('not_done');
      expect(after!.status, 'still open, because the action is still outstanding').toBe('answered');
    });
  });

  it('hands over to HR when they ask for help, and stops calling', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      const [oldest] = await tx.select().from(cases).orderBy(asc(cases.attDate));
      const placed = await placeCaseCall(ctx, oldest!, employee!);
      const opening = await openingTurn(ctx, placed.callId!);
      const turn = await handleTurn(ctx, placed.callId!, opening.nextCaseId!, { digits: '3' });

      expect(turn.done).toBe(true);
      const after = await tx.query.cases.findFirst({ where: eq(cases.id, oldest!.id) });
      expect(after!.status).toBe('needs_hr');
    });
  });

  it('understands "not yet" spoken instead of pressed', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      const [oldest] = await tx.select().from(cases).orderBy(asc(cases.attDate));
      const placed = await placeCaseCall(ctx, oldest!, employee!);
      const opening = await openingTurn(ctx, placed.callId!);
      await handleTurn(ctx, placed.callId!, opening.nextCaseId!, { speech: 'no not yet' });

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, oldest!.id) });
      expect(after!.followUpReply).toBe('not_done');
    });
  });

  it('rings a voice employee once when their reminders fall due', async () => {
    await answeredWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      // Two days on, every date is due its reminder.
      const result = await sendDueFollowUps(ctx, new Date(Date.now() + 3 * 86_400_000));

      expect(result.due).toBe(5);
      expect(result.called, 'one call, not one per date').toBe(1);
      expect(result.sent, 'nothing on WhatsApp for someone set to Call').toBe(0);
      expect(scenario.voice.history()).toHaveLength(1);

      const call = await callAbout(tx, '2026-09-21');
      expect(call.purpose).toBe('follow_up');
    });
  });
});

/**
 * Who the daily run actually contacts.
 *
 *   "If I change to auto in the settings itself, will it change for the entire
 *    organisation, overriding the switches in the dashboard?"
 *
 * No. The customer setting is a gate, not an override: nothing runs at all
 * while it is Manual, and when it is Automatic each employee's own switch still
 * decides, falling back to the customer default only when they have none.
 */
describe('automatic mode, customer setting versus row switch', () => {
  async function absentOnce(settings = {}, employeeOverrides = {}) {
    scenario = await makeScenario(
      { defaultChannel: 'voice', ...settings },
      { preferredChannel: 'voice', ...employeeOverrides },
    );
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-09-21', meaning: 'absent_full', raw: 'A' },
      ]);
    });
  }

  it('contacts an employee with no setting of their own when the customer is automatic', async () => {
    await absentOnce({ operatingMode: 'automatic' }, { operatingMode: null });

    await withTenant(scenario.tenantId, async (tx) => {
      const result = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'schedule' });
      expect(result.messagesSent).toBe(1);
    });
  });

  it('leaves a row set to Manual alone, even when the customer is automatic', async () => {
    await absentOnce({ operatingMode: 'automatic' }, { operatingMode: 'manual' });

    await withTenant(scenario.tenantId, async (tx) => {
      const result = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'schedule' });
      expect(result.messagesSent, 'the row wins over the customer default').toBe(0);
      expect(result.skipped.manual_employee).toBe(1);
    });
  });

  it('contacts a row set to Auto even when the customer default is manual', async () => {
    await absentOnce({ operatingMode: 'manual' }, { operatingMode: 'automatic' });

    await withTenant(scenario.tenantId, async (tx) => {
      const result = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'schedule' });
      expect(result.messagesSent).toBe(1);
    });
  });

  it('still contacts everyone when HR runs the check by hand', async () => {
    await absentOnce({ operatingMode: 'manual' }, { operatingMode: 'manual' });

    await withTenant(scenario.tenantId, async (tx) => {
      const result = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'manual' });
      expect(result.messagesSent, 'Manual means "not on its own", not "never"').toBe(1);
    });
  });
});
