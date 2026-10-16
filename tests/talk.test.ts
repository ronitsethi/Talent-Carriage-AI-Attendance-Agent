import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { calls, cases, employees } from '@/db/schema';
import { runDailyCheck } from '@/lib/detection/run';
import { prepareGrounding, spokenLanguage, talkTurn, type TalkArgs, type TalkEvent } from '@/lib/conversation/talk';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * The talking call as a conversation.
 *
 * The model writes what is said; these tests stand in for it with a fixed
 * verdict and check what the code does with one - which is the part that must
 * never drift: what gets recorded, what the employee is told, what comes next.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

type Verdict = {
  reply_language?: string;
  reply?: string;
  action: 'continue' | 'handover' | 'end';
  outcome?: string;
  leave_choice?: string;
  follow_up?: string;
  handover_reason?: string | null;
  note?: string | null;
};

/** A model that writes this verdict, a few characters at a time. */
function says(verdict: Verdict): NonNullable<TalkArgs['model']> {
  const json = JSON.stringify({
    reply_language: verdict.reply_language ?? 'en-IN',
    reply: verdict.reply ?? 'Okay.',
    action: verdict.action,
    outcome: verdict.outcome ?? 'none',
    leave_choice: verdict.leave_choice ?? 'not_said',
    follow_up: verdict.follow_up ?? 'none',
    handover_reason: verdict.handover_reason ?? null,
    note: verdict.note ?? null,
  });
  return async (_request, onDelta) => {
    for (let i = 0; i < json.length; i += 7) onDelta(json.slice(i, i + 7));
    return { raw: json, usage: { prompt_tokens: 100, completion_tokens: 20 } };
  };
}

async function threeAbsentDays() {
  scenario = await makeScenario(
    { defaultChannel: 'voice', callMode: 'agent', callerId: '+912269871077' },
    { preferredChannel: 'voice' },
  );
  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(
      tx,
      scenario.tenantId,
      scenario.employeeId,
      ['2026-09-21', '2026-09-22', '2026-09-23'].map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A' })),
    );
    for (const date of ['2026-09-21', '2026-09-22', '2026-09-23']) {
      await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
    }
  });
}

/** One turn on the call placed about the newest date, with the search already done. */
async function turn(verdict: Verdict, said: string | null = 'something', date = '2026-09-23') {
  return withTenant(scenario.tenantId, async (tx) => {
    const ctx = scenario.context(tx);
    const newest = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-23') });
    const call = await tx.query.calls.findFirst({ where: eq(calls.caseId, newest!.id) });
    const caseRow = await tx.query.cases.findFirst({ where: eq(cases.attDate, date) });
    const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
    prepareGrounding(`call:${call!.id}`, async () => ({ passages: [], attendance: '' }));

    const events: TalkEvent[] = [];
    const result = await talkTurn(
      ctx,
      { mode: 'first_contact', employee: employee!, call: call!, caseRow: caseRow!, said, preparedKey: `call:${call!.id}`, model: says(verdict) },
      (event) => events.push(event),
    );
    const after = await tx.query.cases.findFirst({ where: eq(cases.id, caseRow!.id) });
    const callAfter = await tx.query.calls.findFirst({ where: eq(calls.id, call!.id) });
    return { result, events, after: after!, call: callAfter! };
  });
}

describe('a talking turn', () => {
  it('names the language before the first word, then streams the reply', async () => {
    await threeAbsentDays();
    const { events, result } = await turn({ action: 'continue', reply_language: 'hi-IN', reply: 'क्या हुआ था उस दिन?' });

    expect(events[0]).toEqual({ type: 'lang', language: 'hi-IN' });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('क्या हुआ था उस दिन?');
    expect(result.language).toBe('hi-IN');
    expect(result.done).toBe(false);
  });

  it('records an outcome heard in any words, and moves on to the oldest date left', async () => {
    await threeAbsentDays();
    const { after, result, call } = await turn(
      { action: 'continue', outcome: 'came_late', note: 'bike broke down, reached at 11', reply: 'Please raise a late-coming regularisation…' },
      'bike kharab ho gayi thi, 11 baje pahuncha',
    );

    expect(after.status).toBe('answered');
    expect(after.replyOption, 'came late is "I was working"').toBe(2);
    expect((after.context as { outcome?: { code: string } }).outcome?.code).toBe('came_late');
    expect(after.replyText).toContain('bike broke down');

    const next = await withTenant(scenario.tenantId, (tx) => tx.query.cases.findFirst({ where: eq(cases.id, result.nextCaseId!) }));
    expect(next!.attDate).toBe('2026-09-21');
    expect(call.transcript!.map((t) => t.role)).toEqual(['employee', 'agent']);
  });

  it('does not settle an absence until they say leave or Loss of Pay', async () => {
    await threeAbsentDays();
    const { after, result } = await turn({ action: 'continue', outcome: 'absent_unwell' }, 'main bimaar tha');

    expect(after.status).not.toBe('answered');
    expect(result.nextCaseId).toBe(after.id);
  });

  it('closes a Loss of Pay day, since there is nothing to chase', async () => {
    await threeAbsentDays();
    const { after } = await turn({ action: 'continue', outcome: 'absent_personal_work', leave_choice: 'loss_of_pay' });

    expect(after.status).toBe('resolved');
    expect(after.followUpDueAt).toBeNull();
    expect(after.closeReason).toBe('Employee chose Loss of Pay');
  });

  it('hands a weekly off to HR', async () => {
    await threeAbsentDays();
    const { after } = await turn({ action: 'continue', outcome: 'weekly_off' });

    expect(after.status).toBe('needs_hr');
    expect(after.needsHrReason).toContain('weekly off');
  });

  it('keeps the last answer when the same turn says goodbye', async () => {
    await threeAbsentDays();
    const { after, result } = await turn({ action: 'end', outcome: 'on_duty_client_visit', note: 'client in Gurgaon' });

    expect(result.done).toBe(true);
    expect(after.status).toBe('answered');
    expect((after.context as { outcome?: { code: string } }).outcome?.code).toBe('on_duty_client_visit');
  });

  it('hands over and ends the call when they ask for a person', async () => {
    await threeAbsentDays();
    const { after, result, call } = await turn({ action: 'handover', handover_reason: 'Driving, call later' });

    expect(result.done).toBe(true);
    expect(after.status).toBe('needs_hr');
    expect(call.outcome).toBe('needs_help');
  });

  it('records nothing from a reply it cannot read, but still says what it heard', async () => {
    await threeAbsentDays();
    const garbled: NonNullable<TalkArgs['model']> = async (_r, onDelta) => {
      const raw = '{"reply_language":"en-IN","reply":"Sorry, could you say that again?","action":"rec';
      onDelta(raw);
      return { raw };
    };
    const { events, after } = await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const caseRow = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-23') });
      const call = await tx.query.calls.findFirst({ where: eq(calls.caseId, caseRow!.id) });
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, scenario.employeeId) });
      prepareGrounding(`call:${call!.id}`, async () => ({ passages: [], attendance: '' }));
      const events: TalkEvent[] = [];
      await talkTurn(
        ctx,
        { mode: 'first_contact', employee: employee!, call: call!, caseRow: caseRow!, said: 'hmm', preparedKey: `call:${call!.id}`, model: garbled },
        (e) => events.push(e),
      );
      return { events, after: await tx.query.cases.findFirst({ where: eq(cases.id, caseRow!.id) }) };
    });

    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(after!.status).not.toBe('answered');
  });
});

describe('which language to answer in', () => {
  it('follows the sentence, in whatever script it came', () => {
    expect(spokenLanguage('leave le lunga', 'en-IN')).toBe('hi-IN');
    expect(spokenLanguage('nahi bas, thank you', 'en-IN')).toBe('hi-IN');
    expect(spokenLanguage('haan main bimaar tha', 'en-IN')).toBe('hi-IN');
    expect(spokenLanguage('मेरी बाइक खराब हो गई थी', 'en-IN')).toBe('hi-IN');
    expect(spokenLanguage('मी आजारी होतो', 'mr-IN')).toBe('mr-IN');
    expect(spokenLanguage('હું બીમાર હતો', 'en-IN')).toBe('gu-IN');
    expect(spokenLanguage('I was sick that day', 'hi-IN')).toBe('en-IN');
    expect(spokenLanguage('I went to the client site in Gurgaon', 'en-IN')).toBe('en-IN');
    expect(spokenLanguage('how many casual leaves do I get?', 'en-IN')).toBe('en-IN');
  });
});
