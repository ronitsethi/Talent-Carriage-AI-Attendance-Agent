import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { queries, employees } from '@/db/schema';
import { env } from '@/lib/env';
import { openai } from '@/lib/knowledge';
import { assertBudget } from '@/lib/models/budget';
import { canSend, deliver, getConversation, sendButtons, sendPlainText, windowOpen, type EngineContext } from './engine';
import { addMessagesToQuery, QUERY_QUIET_MS, recentCaseContact } from './queries';

/**
 * Feedback on a call somebody made to us, asked on WhatsApp a minute after it.
 *
 * Was the question answered; if only partly or not at all, what could have been
 * better, in their own words; and last, how the call was. Buttons are offered
 * for the two choices, but a typed answer counts
 * the same: "haan ho gaya" is a yes, "theek tha" is okay, exactly as a typed
 * reply about an absent date is understood.
 *
 * The first question opens the conversation, so outside the 24-hour window it
 * must be the approved template; once they answer, the window is open and the
 * rest are ordinary messages.
 */

type EmployeeRow = typeof employees.$inferSelect;
type QueryRow = typeof queries.$inferSelect;

export type FeedbackStep = 'resolved' | 'rating' | 'comment';
type Choice<S> = S extends 'resolved' ? 'yes' | 'partly' | 'no' : 'good' | 'okay' | 'poor';

const QUESTIONS = {
  resolved: {
    ask: (name: string) => `Hi ${name}, thank you for calling the attendance desk. Did we answer your question?`,
    choices: [
      ['yes', 'Yes'],
      ['partly', 'Partly'],
      ['no', 'No'],
    ],
  },
  rating: {
    ask: (lead: string) => `${lead} Lastly, how was your call with the assistant?`,
    choices: [
      ['good', 'Good'],
      ['okay', 'Okay'],
      ['poor', 'Poor'],
    ],
  },
} as const;

const ASK_COMMENT = 'Sorry about that. What could we have done better? Just type your reply.';
const THANKS = 'Thank you for your feedback. It helps us improve.';

/** How long the two questions wait for an answer, and how long the free-text one does. */
const ANSWER_WINDOW_MS = 24 * 3600_000;

export const feedbackPayload = (queryId: string, step: 'resolved' | 'rating', choice: string) => `fb:${queryId}:${step}:${choice}`;

export function parseFeedbackSelection(id: string | null | undefined) {
  const match = /^fb:([0-9a-f-]{36}):(resolved|rating):(yes|partly|no|good|okay|poor)$/.exec(id ?? '');
  return match ? { queryId: match[1]!, step: match[2] as 'resolved' | 'rating', choice: match[3]! } : null;
}

/**
 * Asks for feedback on a call that has ended. Quiet hours hold it back rather
 * than drop it: `retryAt` says when to try again.
 */
export async function sendQueryFeedback(
  ctx: EngineContext,
  queryId: string,
): Promise<{ sent: boolean; reason?: string; retryAt?: Date }> {
  const query = await ctx.tx.query.queries.findFirst({ where: eq(queries.id, queryId) });
  if (!query || query.channel !== 'voice') return { sent: false, reason: 'not a call' };
  if (query.feedbackSentAt) return { sent: false, reason: 'already asked' };
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, query.employeeId) });
  if (!employee) return { sent: false, reason: 'no employee' };

  const block = canSend(ctx, employee);
  if (block.blocked) {
    return block.reason === 'Quiet hours'
      ? { sent: false, reason: block.reason, retryAt: new Date(Date.now() + 15 * 60_000) }
      : { sent: false, reason: block.reason };
  }

  const name = employee.fullName.split(/\s+/)[0] ?? employee.fullName;
  const body = QUESTIONS.resolved.ask(name);
  const buttons = QUESTIONS.resolved.choices.map(([choice, title]) => ({ id: feedbackPayload(queryId, 'resolved', choice), title }));
  const conversation = await getConversation(ctx, employee.id);

  const sent = windowOpen(conversation, new Date())
    ? await sendButtons(ctx, employee, body, buttons)
    : await deliver(
        ctx,
        employee,
        {
          kind: 'template',
          to: employee.mobileE164!,
          templateName: ctx.feedbackTemplate?.name ?? 'call_feedback',
          language: ctx.feedbackTemplate?.language ?? 'en',
          variables: [name],
          buttonPayloads: buttons.map((b) => b.id),
          preview: body,
        },
        { kind: 'template', body, templateName: ctx.feedbackTemplate?.name ?? 'call_feedback' },
      );

  await addMessagesToQuery(ctx.tx, queryId, [sent.messageId]);
  await ctx.tx.update(queries).set({ feedbackSentAt: new Date(), feedbackStep: 'resolved' }).where(eq(queries.id, queryId));
  return { sent: true };
}

/** A tapped answer to one of the feedback questions. */
export async function answerFeedbackTap(
  ctx: EngineContext,
  employee: EmployeeRow,
  inboundId: string,
  tap: { queryId: string; step: 'resolved' | 'rating'; choice: string },
): Promise<boolean> {
  const query = await ctx.tx.query.queries.findFirst({
    where: and(eq(queries.id, tap.queryId), eq(queries.employeeId, employee.id)),
  });
  if (!query) return false;
  await addMessagesToQuery(ctx.tx, query.id, [inboundId]);
  await record(ctx, employee, query, tap.step, tap.choice);
  return true;
}

/**
 * A typed message that may be an answer to feedback still waiting on one.
 * False when it is not - a question, or an answer about an absent date - so
 * the message is handled as it would have been anyway.
 */
export async function answerFeedbackTyped(
  ctx: EngineContext,
  employee: EmployeeRow,
  inboundId: string,
  text: string,
  at: Date,
): Promise<boolean> {
  const query = await ctx.tx.query.queries.findFirst({
    where: and(
      eq(queries.employeeId, employee.id),
      inArray(queries.feedbackStep, ['resolved', 'rating', 'comment']),
      gt(queries.feedbackSentAt, new Date(at.getTime() - ANSWER_WINDOW_MS)),
    ),
    orderBy: desc(queries.feedbackSentAt),
  });
  if (!query?.feedbackStep || query.feedbackStep === 'done') return false;

  // Talking about a date since the feedback was asked: that conversation has
  // their attention. Whichever spoke to them last is the one they are answering.
  const recent = await recentCaseContact(ctx.tx, employee.id, at, inboundId);
  if (recent && recent.at > query.lastActivityAt) return false;

  const step = query.feedbackStep as FeedbackStep;
  if (step === 'comment') {
    // The free-text question waits half an hour; anything later is something else.
    if (at.getTime() - query.lastActivityAt.getTime() > QUERY_QUIET_MS) {
      await ctx.tx.update(queries).set({ feedbackStep: 'done' }).where(eq(queries.id, query.id));
      return false;
    }
    await addMessagesToQuery(ctx.tx, query.id, [inboundId]);
    await record(ctx, employee, query, 'comment', text.trim());
    return true;
  }

  const choice = byRules(step, text) ?? (await byModel(step, text));
  if (!choice) return false;
  await addMessagesToQuery(ctx.tx, query.id, [inboundId]);
  await record(ctx, employee, query, step, choice);
  return true;
}

/**
 * Writes an answer down and asks whatever comes next: after a "partly" or a
 * "no", what could have been better; then, always last, how the call was. A
 * second tap on a question already answered changes the answer, and asks
 * nothing again.
 */
async function record(ctx: EngineContext, employee: EmployeeRow, query: QueryRow, step: FeedbackStep, answer: string) {
  const at = new Date();
  const current = query.feedbackStep;
  const send = async (send: () => Promise<{ messageId: string }>) => {
    const sent = await send();
    await addMessagesToQuery(ctx.tx, query.id, [sent.messageId]);
  };
  const askRating = (lead: string) => {
    const buttons = QUESTIONS.rating.choices.map(([choice, title]) => ({ id: feedbackPayload(query.id, 'rating', choice), title }));
    return send(() => sendButtons(ctx, employee, QUESTIONS.rating.ask(lead), buttons));
  };

  if (step === 'resolved') {
    const unhappy = answer === 'partly' || answer === 'no';
    await ctx.tx
      .update(queries)
      .set({
        feedbackResolved: answer as Choice<'resolved'>,
        feedbackAnsweredAt: at,
        ...(current === 'resolved' ? { feedbackStep: unhappy ? 'comment' : 'rating' } : {}),
      })
      .where(eq(queries.id, query.id));
    if (current === 'resolved') {
      if (unhappy) await send(() => sendPlainText(ctx, employee, ASK_COMMENT));
      else await askRating('Glad to hear it.');
    }
    return;
  }

  if (step === 'comment') {
    await ctx.tx
      .update(queries)
      .set({ feedbackComment: answer, feedbackAnsweredAt: at, feedbackStep: 'rating' })
      .where(eq(queries.id, query.id));
    await askRating('Thank you, we have noted it.');
    return;
  }

  await ctx.tx
    .update(queries)
    .set({ feedbackRating: answer as Choice<'rating'>, feedbackAnsweredAt: at, ...(current === 'rating' ? { feedbackStep: 'done' } : {}) })
    .where(eq(queries.id, query.id));
  if (current === 'rating') await send(() => sendPlainText(ctx, employee, THANKS));
}

/*
 * What people actually type, in English, Hindi in English letters, and
 * Devanagari. Only short replies are read this way; anything longer goes to
 * the model, which can tell "haan, but I still don't know the deadline" from
 * a plain yes.
 */
const WORDS: Record<'resolved' | 'rating', Record<string, string[]>> = {
  resolved: {
    yes: ['yes', 'yeah', 'yep', 'yup', 'y', 'haan', 'han', 'ha', 'haanji', 'hanji', 'ji', 'answered', 'resolved', 'हाँ', 'हां', 'जी', 'हांजी', '👍'],
    partly: ['partly', 'partially', 'somewhat', 'thoda', 'thora', 'kuch', 'half', 'थोड़ा', 'कुछ'],
    no: ['no', 'nope', 'nah', 'n', 'nahi', 'nahin', 'nhi', 'na', 'नहीं', 'ना', '👎'],
  },
  rating: {
    good: ['good', 'great', 'excellent', 'nice', 'awesome', 'accha', 'acha', 'achha', 'badhiya', 'badiya', 'mast', 'बढ़िया', 'अच्छा', 'अच्छी', '👍'],
    okay: ['okay', 'ok', 'fine', 'average', 'theek', 'thik', 'thick', 'ठीक', 'ठीक-ठाक'],
    poor: ['poor', 'bad', 'worst', 'terrible', 'bekar', 'bekaar', 'bura', 'kharab', 'ganda', 'खराब', 'बेकार', 'बुरा', '👎'],
  },
};

function byRules(step: 'resolved' | 'rating', text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/[.,!?।]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > 3) return null;
  const found = Object.entries(WORDS[step])
    .filter(([, list]) => words.some((word) => list.includes(word)))
    .map(([choice]) => choice);
  return found.length === 1 ? found[0]! : null;
}

async function byModel(step: 'resolved' | 'rating', text: string): Promise<string | null> {
  const question = step === 'resolved' ? 'Did we answer your question?' : 'How was your call with the assistant?';
  const choices = QUESTIONS[step].choices.map(([choice]) => choice);
  try {
    await assertBudget('whatsapp');
    const json = await openai(
      '/chat/completions',
      {
        model: env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              `An employee was asked on WhatsApp: "${question}" (options: ${choices.join(', ')}). They may reply in ` +
              'English, Hindi or a mix, in any script. Pick the option their reply means. Pick "other" if it does not ' +
              'answer this question - a new question, or something about something else.',
          },
          { role: 'user', content: text.slice(0, 500) },
        ],
        temperature: 0,
        max_tokens: 20,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'feedback',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['choice'],
              properties: { choice: { type: 'string', enum: [...choices, 'other'] } },
            },
          },
        },
      },
      'whatsapp',
      'Reading the feedback',
    );
    const content = (json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '';
    const choice = (JSON.parse(content) as { choice: string }).choice;
    return choices.includes(choice as never) ? choice : null;
  } catch (error) {
    console.error('[feedback] could not read a typed answer:', (error as Error).message);
    return null;
  }
}
