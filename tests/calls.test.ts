import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { calls, cases, employees } from '@/db/schema';
import { runDailyCheck } from '@/lib/detection/run';
import { handleTurn, openingTurn } from '@/lib/voice/session';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

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
      const latest = (await tx.select().from(calls)).at(-1)!;
      expect(call).toBeDefined();

      const opening = await openingTurn(ctx, latest.id);
      expect(opening.speak).toContain('5 days of attendance still to be confirmed');
      expect(opening.speak).toContain('25 September');
      expect(opening.done).toBe(false);

      // Answer 25 September with "1 - I was absent".
      const afterFirst = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '1' });
      expect(afterFirst.speak).toContain('Please apply leave for 25 September');
      expect(afterFirst.speak).toContain('4 more days pending');
      expect(afterFirst.speak).toContain('21 September'); // oldest next
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
      const latest = (await tx.select().from(calls)).at(-1)!;
      const opening = await openingTurn(ctx, latest.id);

      // No key pressed; they just said it. Handled by the same classifier that
      // reads typed WhatsApp replies.
      const turn = await handleTurn(ctx, latest.id, opening.nextCaseId!, { speech: 'no I was working that day' });
      const answered = await tx.query.cases.findFirst({ where: eq(cases.id, opening.nextCaseId!) });
      expect(answered!.replyOption).toBe(2);
      expect(turn.speak).toContain('regularisation');
    });
  });

  it('asks again once when it cannot tell, then hands over to HR', async () => {
    await absentAllWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const latest = (await tx.select().from(calls)).at(-1)!;
      const opening = await openingTurn(ctx, latest.id);

      const first = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '9' });
      expect(first.retry).toBe(true);
      expect(first.speak).toContain('did not catch that');

      const second = await handleTurn(ctx, latest.id, opening.nextCaseId!, { digits: '' });
      expect(second.done).toBe(true);
      expect(second.speak).toContain('HR team');
    });
  });

  it('keeps a transcript, so a call reads like a conversation in the portal', async () => {
    await absentAllWeek();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const latest = (await tx.select().from(calls)).at(-1)!;
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
