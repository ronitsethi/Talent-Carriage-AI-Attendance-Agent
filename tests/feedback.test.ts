import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { conversations, jobs, queries } from '@/db/schema';
import { getConversation, handleInbound } from '@/lib/conversation/engine';
import { endCallQuery, FEEDBACK_AFTER_MS, startCallQuery } from '@/lib/conversation/queries';
import { feedbackPayload, sendQueryFeedback } from '@/lib/conversation/feedback';
import { claim, complete } from '@/lib/jobs/queue';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, typeText, type Scenario } from './helpers/scenario';

// A typed answer the word lists cannot place goes to the model; here the model
// is unavailable, which is what it must survive anyway.
vi.mock('@/lib/knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge')>()),
  openai: async () => {
    throw new Error('no model in tests');
  },
}));

/**
 * Feedback on a call somebody made to us: asked on WhatsApp a minute after the
 * call, by template if the chat window is shut, and answered by tap or typing.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

async function endedCall() {
  scenario = await makeScenario();
  return withTenant(scenario.tenantId, async (tx) => {
    const queryId = await startCallQuery(tx, { tenantId: scenario.tenantId, employeeId: scenario.employeeId, style: 'agent', greeting: 'Hello' });
    await endCallQuery(tx, queryId, 'queries/x.ogg');
    await endCallQuery(tx, queryId); // the worker and the recording both say so
    return queryId;
  });
}

const ask = (queryId: string) =>
  withTenant(scenario.tenantId, async (tx) => sendQueryFeedback(scenario.context(tx), queryId));

const reply = (inbound: Parameters<typeof handleInbound>[1]) =>
  withTenant(scenario.tenantId, (tx) => handleInbound(scenario.context(tx), inbound));

const tap = (id: string, title: string) => ({
  providerMessageId: `wamid.${randomUUID()}`,
  from: scenario.mobile,
  kind: 'button' as const,
  selectionId: id,
  selectionTitle: title,
  receivedAt: new Date(),
  raw: {},
});

const row = (queryId: string) =>
  withTenant(scenario.tenantId, async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, queryId) }))!);

const sent = () => scenario.channel.history().map((s) => s.message as { kind: string; body?: string; templateName?: string });

describe('feedback after a call to us', () => {
  it('is queued once, a minute after the call ends', async () => {
    const queryId = await endedCall();
    const queued = await withPlatformScope((tx) =>
      tx.select().from(jobs).where(and(eq(jobs.kind, 'query_feedback'), eq(jobs.tenantId, scenario.tenantId))),
    );
    expect(queued).toHaveLength(1);
    const ended = (await row(queryId)).endedAt!;
    expect(queued[0]!.runAt.getTime() - ended.getTime()).toBe(FEEDBACK_AFTER_MS);
    expect(queued[0]!.payload).toEqual({ queryId });
  });

  it('is picked up by the job runner once it is due - a customer\'s job, not only the platform\'s', async () => {
    await endedCall();
    await withPlatformScope((tx) =>
      tx.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(and(eq(jobs.kind, 'query_feedback'), eq(jobs.tenantId, scenario.tenantId))),
    );
    const claimed = (await claim('test-runner', 50)).filter((job) => job.tenantId === scenario.tenantId);
    expect(claimed.map((job) => job.kind)).toEqual(['query_feedback']);
    for (const job of claimed) await complete(job.id);
  });

  it('opens with the approved template when the chat window is shut, and asks only once', async () => {
    const queryId = await endedCall();
    expect(await ask(queryId)).toEqual({ sent: true });
    expect(await ask(queryId)).toMatchObject({ sent: false, reason: 'already asked' });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ kind: 'template', templateName: 'call_feedback' });
    expect(await row(queryId)).toMatchObject({ feedbackStep: 'resolved' });
  });

  it('asks with plain buttons, free, when they have written to us in the last day', async () => {
    const queryId = await endedCall();
    await withTenant(scenario.tenantId, async (tx) => {
      const conversation = await getConversation(scenario.context(tx), scenario.employeeId);
      await tx.update(conversations).set({ windowExpiresAt: new Date(Date.now() + 3600_000) }).where(eq(conversations.id, conversation.id));
    });
    await ask(queryId);
    expect(sent()[0]).toMatchObject({ kind: 'buttons' });
  });

  it('goes Yes, then the rating, then thank you - nothing more asked of a happy caller', async () => {
    const queryId = await endedCall();
    await ask(queryId);
    await reply(tap(feedbackPayload(queryId, 'resolved', 'yes'), 'Yes'));
    expect(sent().at(-1)!.body).toContain('Lastly, how was your call');
    await reply(tap(feedbackPayload(queryId, 'rating', 'good'), 'Good'));
    expect(sent().at(-1)!.body).toContain('Thank you for your feedback');
    expect(await row(queryId)).toMatchObject({ feedbackResolved: 'yes', feedbackRating: 'good', feedbackStep: 'done' });
  });

  it('asks what could be better after a "partly", keeps their words, and asks for the rating last', async () => {
    const queryId = await endedCall();
    await ask(queryId);
    await reply(tap(feedbackPayload(queryId, 'resolved', 'partly'), 'Partly'));
    expect(sent().at(-1)!.body).toContain('What could we have done better?');
    await reply(typeText(scenario.mobile, 'Deadline nahi bataya'));
    expect(sent().at(-1)!.body).toContain('Lastly, how was your call');
    await reply(tap(feedbackPayload(queryId, 'rating', 'okay'), 'Okay'));
    expect(await row(queryId)).toMatchObject({ feedbackResolved: 'partly', feedbackComment: 'Deadline nahi bataya', feedbackRating: 'okay', feedbackStep: 'done' });
    expect(sent().at(-1)!.body).toContain('Thank you for your feedback');
  });

  it('understands typed answers as it understands typed replies about a date', async () => {
    const queryId = await endedCall();
    await ask(queryId);
    await reply(typeText(scenario.mobile, 'haan ho gaya'));
    await reply(typeText(scenario.mobile, 'बेकार'));
    expect(await row(queryId)).toMatchObject({ feedbackResolved: 'yes', feedbackRating: 'poor', feedbackStep: 'done' });
  });

  it('leaves a message that is not an answer to be handled as it would have been', async () => {
    const queryId = await endedCall();
    await ask(queryId);
    await withTenant(scenario.tenantId, async (tx) => {
      await handleInbound(
        { ...scenario.context(tx), hooks: { answerQuestion: async () => ({ text: 'You get 12 a year.', answered: true }) } },
        typeText(scenario.mobile, 'How many casual leaves do I get in a year?'),
      );
    });
    expect(await row(queryId)).toMatchObject({ feedbackStep: 'resolved', feedbackResolved: null });
    expect(sent().at(-1)!.body).toBe('You get 12 a year.');
  });

  /** An absent date asked about on WhatsApp, now. */
  const askAboutADate = () =>
    withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' }]);
      await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
    });

  it('takes a typed answer as feedback when the feedback was asked after the last word about a date', async () => {
    const queryId = await endedCall();
    await askAboutADate();
    await new Promise((r) => setTimeout(r, 20));
    await ask(queryId);
    await reply(typeText(scenario.mobile, 'haan'));
    expect(await row(queryId)).toMatchObject({ feedbackResolved: 'yes', feedbackStep: 'rating' });
  });

  it('leaves a typed answer to the date when the date was asked about after the feedback', async () => {
    const queryId = await endedCall();
    await ask(queryId);
    await new Promise((r) => setTimeout(r, 20));
    await askAboutADate();
    await reply(typeText(scenario.mobile, 'haan'));
    expect(await row(queryId)).toMatchObject({ feedbackResolved: null, feedbackStep: 'resolved' });
  });
});
