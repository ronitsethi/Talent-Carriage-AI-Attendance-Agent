import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { calls, cases, messages, queries } from '@/db/schema';
import { handleInbound, type EngineHooks } from '@/lib/conversation/engine';
import { runDailyCheck } from '@/lib/detection/run';
import { addCallTurn, endCallQuery, QUERY_QUIET_MS, startCallQuery } from '@/lib/conversation/queries';
import { callsForCase, queryConversation, summaryIsStale } from '@/lib/conversation/summary';
import { caseCounts, caseDetail, listCases, listQueries, queryDetail } from '@/lib/queries';
import { giveAttendance, makeScenario, typeText, type Scenario } from './helpers/scenario';

// The classifier is a model; here anything ending in a question mark is a
// question, and anything else an answer about the date.
vi.mock('@/lib/conversation/classify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversation/classify')>()),
  classifyReply: async (text: string) =>
    text.trim().endsWith('?')
      ? { intent: 'question', option: null, confidence: 0.95, source: 'model', question: text }
      : { intent: 'was_absent', option: null, confidence: 0.9, source: 'model' },
}));

/**
 * Queries: what employees ask of their own accord, kept apart from the cases.
 * A call is one query; a chat is one until it has been quiet for half an hour.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const answering = (text: string): EngineHooks => ({ answerQuestion: async () => ({ text, answered: true }) });

/** A WhatsApp message from the scenario's employee, sent at `at`. */
async function writes(text: string, at = new Date(), reply = 'An answer.') {
  await withTenant(scenario.tenantId, (tx) =>
    handleInbound({ ...scenario.context(tx), hooks: answering(reply) }, { ...typeText(scenario.mobile, text), receivedAt: at }),
  );
}

const allQueries = () =>
  withTenant(scenario.tenantId, (tx) => tx.select().from(queries).where(eq(queries.tenantId, scenario.tenantId)));

describe('a WhatsApp query', () => {
  it('holds a question asked with nothing open, and the answer to it', async () => {
    scenario = await makeScenario();
    await writes('How many casual leaves do I get?', new Date(), 'You get 12 casual leaves a year.');

    const [query] = await allQueries();
    expect(query).toMatchObject({ channel: 'whatsapp', employeeId: scenario.employeeId });
    const lines = await withTenant(scenario.tenantId, (tx) => queryConversation(tx, query!));
    expect(lines.map((line) => [line.role, line.text])).toEqual([
      ['employee', 'How many casual leaves do I get?'],
      ['agent', 'You get 12 casual leaves a year.'],
    ]);
  });

  it('is one query until the chat has been quiet for half an hour', async () => {
    scenario = await makeScenario();
    await writes('How many casual leaves do I get?');
    await writes('And sick leaves?');
    expect(await allQueries()).toHaveLength(1);

    // Half an hour and a minute of quiet since the last message, either way.
    const [first] = await allQueries();
    await withTenant(scenario.tenantId, (tx) =>
      tx
        .update(queries)
        .set({ lastActivityAt: new Date(Date.now() - QUERY_QUIET_MS - 60_000) })
        .where(eq(queries.id, first!.id)),
    );
    await writes('What is the notice period?');
    const all = await allQueries();
    expect(all).toHaveLength(2);
    const second = all.find((q) => q.id !== first!.id)!;
    expect(await withTenant(scenario.tenantId, (tx) => queryConversation(tx, second))).toHaveLength(2);
    expect(await withTenant(scenario.tenantId, (tx) => queryConversation(tx, first!))).toHaveLength(4);
  });

  it('stays out of the case pages', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' }]);
    });
    // Asked before any case exists: a query.
    await writes('How many casual leaves do I get?');
    const caseId = await withTenant(scenario.tenantId, async (tx) => {
      await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
      return (await tx.query.cases.findFirst())!.id;
    });

    const detail = await caseDetail(scenario.tenantId, caseId);
    expect(detail!.transcript.some((m) => m.body?.includes('casual leaves'))).toBe(false);
    expect(detail!.transcript.length).toBeGreaterThan(0);
  });

  it('is not opened by a reply about a date', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' }]);
      await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
    });
    await writes('By when must I regularise?');
    expect(await allQueries()).toHaveLength(0);
    const linked = await withTenant(scenario.tenantId, (tx) => tx.select().from(messages).where(eq(messages.tenantId, scenario.tenantId)));
    expect(linked.every((m) => m.queryId === null)).toBe(true);
  });
});

describe('a call somebody made to us', () => {
  it('is one query, turn by turn, with what the caller heard of a reply they cut off', async () => {
    scenario = await makeScenario();
    const id = await withTenant(scenario.tenantId, async (tx) => {
      const queryId = await startCallQuery(tx, {
        tenantId: scenario.tenantId,
        employeeId: scenario.employeeId,
        style: 'agent',
        greeting: 'Hello, how can I help?',
      });
      await addCallTurn(tx, queryId, scenario.employeeId, [
        { role: 'employee', text: 'How many leaves do I have?' },
        { role: 'agent', text: 'You have 4 sick leaves and 6 casual leaves left this year.' },
      ]);
      await addCallTurn(
        tx,
        queryId,
        scenario.employeeId,
        [
          { role: 'employee', text: 'And the notice period?' },
          { role: 'agent', text: 'It is 30 days.' },
        ],
        'You have 4 sick leaves',
      );
      await endCallQuery(tx, queryId, 'queries/x.ogg');
      return queryId;
    });

    const detail = await queryDetail(scenario.tenantId, id);
    expect(detail!.query).toMatchObject({ channel: 'voice', callStyle: 'agent', recordingUri: 'queries/x.ogg' });
    expect(detail!.query.endedAt).not.toBeNull();
    expect(detail!.lines.map((line) => line.role)).toEqual(['agent', 'employee', 'agent', 'employee', 'agent']);
    expect(detail!.lines[2]!.heard).toBe('You have 4 sick leaves');

    const [listed] = await listQueries(scenario.tenantId);
    expect(listed).toMatchObject({ id, channel: 'voice', callStyle: 'agent', hasRecording: true });
  });

  it('stays one query when the same call greets again, as it does when LiveKit hands it to a second process', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      const args = { tenantId: scenario.tenantId, employeeId: scenario.employeeId, style: 'agent' as const, providerCallId: 'attendance-ask_+91_x' };
      const first = await startCallQuery(tx, { ...args, greeting: 'Hello, how can I help?' });
      const again = await startCallQuery(tx, { ...args, greeting: 'Hi, what would you like to know?' });
      expect(again).toBe(first);
      const rows = await tx.query.queries.findMany({ where: eq(queries.providerCallId, 'attendance-ask_+91_x') });
      expect(rows).toHaveLength(1);
      // The greeting they hear is the second one.
      expect(rows[0]!.transcript?.map((l) => l.text)).toEqual(['Hi, what would you like to know?']);
    });
  });

  it("cannot be written to through another employee's number", async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      const queryId = await startCallQuery(tx, { tenantId: scenario.tenantId, employeeId: scenario.employeeId, style: 'keypad' });
      await addCallTurn(tx, queryId, '00000000-0000-0000-0000-000000000000', [{ role: 'employee', text: 'not mine' }]);
      const row = await tx.query.queries.findFirst({ where: eq(queries.id, queryId) });
      expect(row!.transcript).toEqual([]);
    });
  });
});

describe('summaries', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 22, 10, minutes)).toISOString();
  const lines = [
    { role: 'employee' as const, text: 'How many leaves?', at: at(0) },
    { role: 'agent' as const, text: 'Four.', at: at(1) },
  ];

  it('are written when missing, and again only once something newer is said', () => {
    expect(summaryIsStale(null, lines)).toBe(true);
    expect(summaryIsStale(new Date(at(2)), lines)).toBe(false);
    expect(summaryIsStale(new Date(at(2)), [...lines, { role: 'employee', text: 'Thanks', at: at(3) }])).toBe(true);
    expect(summaryIsStale(null, [])).toBe(false);
  });
});

describe("a case's calls", () => {
  it('are the call placed about its date, and any call that settled it - not calls about other dates', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-08-17', meaning: 'absent_full', raw: 'A|A' },
        { date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' },
        { date: '2026-08-19', meaning: 'absent_full', raw: 'A|A' },
      ]);
      for (const date of ['2026-08-17', '2026-08-18', '2026-08-19']) {
        await runDailyCheck(scenario.context(tx), { date, trigger: 'manual', createOnly: true });
      }
      const byDate = Object.fromEntries((await tx.select().from(cases)).map((c) => [c.attDate, c]));
      const started = new Date(Date.now() - 10 * 60_000);
      // One call placed about the 19th, which went on to settle the 18th as well.
      const [call] = await tx
        .insert(calls)
        .values({
          tenantId: scenario.tenantId,
          caseId: byDate['2026-08-19']!.id,
          employeeId: scenario.employeeId,
          provider: 'livekit',
          status: 'completed',
          startedAt: started,
          endedAt: new Date(started.getTime() + 3 * 60_000),
        })
        .returning();
      await tx.insert(messages).values({
        tenantId: scenario.tenantId,
        caseId: byDate['2026-08-18']!.id,
        direction: 'inbound',
        channel: 'voice',
        kind: 'voice',
        status: 'received',
        body: 'Said on the call: Absent - unwell',
        createdAt: new Date(started.getTime() + 60_000),
      });

      expect((await callsForCase(tx, byDate['2026-08-19']!)).map((c) => c.id)).toEqual([call!.id]);
      expect((await callsForCase(tx, byDate['2026-08-18']!)).map((c) => c.id)).toEqual([call!.id]);
      expect(await callsForCase(tx, byDate['2026-08-17']!)).toEqual([]);
    });
  });
});

describe('case or query: the half hour after the last word about a date', () => {
  /** A date asked about on WhatsApp, as if the asking happened `minutesAgo` minutes ago. */
  async function askedAbout(minutesAgo: number) {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' }]);
      await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
      const then = new Date(Date.now() - minutesAgo * 60_000);
      await tx.update(messages).set({ createdAt: then, sentAt: then }).where(eq(messages.tenantId, scenario.tenantId));
    });
    return withTenant(scenario.tenantId, async (tx) => (await tx.query.cases.findFirst())!);
  }
  const messageNamed = (body: string) =>
    withTenant(scenario.tenantId, async (tx) => (await tx.query.messages.findFirst({ where: eq(messages.body, body) }))!);

  it('keeps a question asked within it as part of the case', async () => {
    const caseRow = await askedAbout(10);
    await writes('By when must I regularise?');
    expect(await allQueries()).toHaveLength(0);
    expect((await messageNamed('By when must I regularise?')).caseId).toBe(caseRow.id);
  });

  it('makes a question asked after it a query of its own', async () => {
    await askedAbout(45);
    await writes('How many casual leaves do I get?', new Date(), 'You get 12.');
    const [query] = await allQueries();
    expect(query).toBeDefined();
    const asked = await messageNamed('How many casual leaves do I get?');
    expect(asked).toMatchObject({ queryId: query!.id, caseId: null });
  });

  it('keeps an answer about the date with the case, however late it comes', async () => {
    const caseRow = await askedAbout(240);
    await writes('I was sick that day');
    expect(await allQueries()).toHaveLength(0);
    expect((await messageNamed('I was sick that day')).caseId).toBe(caseRow.id);
  });

  it('files a question asked just after a date was settled under that case', async () => {
    const caseRow = await askedAbout(5);
    await withTenant(scenario.tenantId, (tx) => tx.update(cases).set({ status: 'answered' }).where(eq(cases.id, caseRow.id)));
    await writes('And by when should I apply it?', new Date(), 'Within 7 days.');
    expect(await allQueries()).toHaveLength(0);
    expect((await messageNamed('And by when should I apply it?')).caseId).toBe(caseRow.id);
    expect((await messageNamed('Within 7 days.')).caseId).toBe(caseRow.id);
  });
});

describe('the Follow-up tab', () => {
  it("holds a case whose follow-up went out and is not yet done - and only until it is", async () => {
    scenario = await makeScenario();
    const id = await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' }]);
      await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual', createOnly: true });
      const row = (await tx.query.cases.findFirst())!;
      await tx.update(cases).set({ status: 'answered', followUpSentAt: new Date() }).where(eq(cases.id, row.id));
      return row.id;
    });

    let counts = await caseCounts(scenario.tenantId);
    expect(counts).toMatchObject({ follow_up: 1, answered: 0, open: 1 });
    expect((await listCases(scenario.tenantId, { status: 'follow_up' })).map((c) => c.id)).toEqual([id]);

    await withTenant(scenario.tenantId, (tx) => tx.update(cases).set({ followUpReply: 'not_done' }).where(eq(cases.id, id)));
    expect((await caseCounts(scenario.tenantId)).follow_up).toBe(1);

    await withTenant(scenario.tenantId, (tx) =>
      tx.update(cases).set({ followUpReply: 'done', status: 'resolved' }).where(eq(cases.id, id)),
    );
    counts = await caseCounts(scenario.tenantId);
    expect(counts).toMatchObject({ follow_up: 0, resolved: 1, open: 0 });
  });
});
