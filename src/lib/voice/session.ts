import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { calls, cases, employees, messages, usageEvents } from '@/db/schema';
import { classifyReply } from '@/lib/conversation/classify';
import { dateLabel, type OptionNumber } from '@/lib/conversation/flow';
import {
  callBacklogOpening,
  callGreeting,
  datePrompt,
  followUpChoiceFromDigits,
  followUpChoiceFromSpeech,
  followUpPrompt,
  optionFromDigits,
  spokenBacklogSummary,
  spokenClosing,
  spokenDate,
  spokenFollowUpAcknowledgement,
  spokenFollowUpClosing,
  spokenFollowUpNotUnderstood,
  spokenFollowUpSummary,
  spokenGuidance,
  spokenHandover,
  spokenNotUnderstood,
  type PromptStyle,
} from '@/lib/conversation/voice-script';
import { recordAnswer, UNANSWERED, type CaseRow, type EmployeeRow, type EngineContext } from '@/lib/conversation/engine';
import { recordFollowUpChoice } from '@/lib/conversation/follow-up-state';
import { followUpAcknowledgement, type FollowUpChoice } from '@/lib/conversation/flow';
import { halfOfDay, type Meaning } from '@/lib/mapping/meanings';
import type { CallTurnInput, VoiceProvider } from './types';

export type VoiceContext = EngineContext & {
  voice: VoiceProvider;
  /**
   * The provider that holds a spoken conversation, when the customer has one
   * configured. Null means every call is a keypad call, which is the default.
   */
  voiceAgent?: VoiceProvider | null;
  baseUrl: string;
};
export type CallRow = typeof calls.$inferSelect;

/**
 * Why the phone is ringing.
 *
 * `first_contact` asks about the absence itself. `follow_up` is the day-2
 * reminder: it asks whether the action the employee was given has been done,
 * so the keypad means something different and the script must say so.
 */
export type CallPurpose = 'first_contact' | 'follow_up';

/** One spoken turn: what the agent says, and what happens next. */
export type CallTurn = {
  /** The question itself, which is what the caller is listening for. */
  speak: string;
  /**
   * Anything said before the question - a greeting, guidance for the date just
   * answered, how many days are left. It is played outside the listening window
   * so a long preamble never eats into the time the employee has to press a key.
   */
  intro?: string;
  /** The case the next keypad press belongs to; null when the call is ending. */
  nextCaseId: string | null;
  done: boolean;
  /** True when the same question should be asked again after a bad input. */
  retry?: boolean;
};

const spokenFor = (row: { attDate: string; meaning: string }) =>
  spokenDate(row.attDate, halfOfDay(row.meaning as Meaning) as 'first' | 'second' | null);

/**
 * How this call's questions should be worded.
 *
 * A keypad call has to read out the keys; a call carried by the conversation
 * agent asks the question the way a person would, because the employee can
 * simply answer.
 */
const styleOf = (call: { provider: string }): PromptStyle => (call.provider === 'livekit' ? 'spoken' : 'keypad');

/** Dates this employee still has to answer, oldest first. */
async function pending(ctx: VoiceContext, employeeId: string, excludeCaseId?: string) {
  return ctx.tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.employeeId, employeeId),
        inArray(cases.status, [...UNANSWERED]),
        excludeCaseId ? sql`${cases.id} <> ${excludeCaseId}` : sql`true`,
      ),
    )
    .orderBy(asc(cases.attDate));
}

/**
 * Dates whose action is still being chased, oldest first.
 *
 * Only dates the employee actually answered appear here: an ignored question is
 * never chased, so it can never reach the reminder stage.
 */
async function pendingFollowUps(ctx: VoiceContext, employeeId: string, excludeCaseId?: string) {
  return ctx.tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.employeeId, employeeId),
        eq(cases.status, 'answered'),
        sql`${cases.replyOption} is not null`,
        sql`${cases.followUpReply} is null`,
        excludeCaseId ? sql`${cases.id} <> ${excludeCaseId}` : sql`true`,
      ),
    )
    .orderBy(asc(cases.attDate));
}

/**
 * Which call this case is due: the first question, or the reminder.
 *
 * Deciding from the case itself means "Call now" on a case that has already
 * been answered asks the next question rather than repeating the last one.
 */
export function callPurposeFor(caseRow: CaseRow): CallPurpose {
  return caseRow.status === 'answered' && caseRow.replyOption && !caseRow.followUpReply
    ? 'follow_up'
    : 'first_contact';
}

/**
 * Places the call for one date.
 *
 * The call is *about* that date, but once answered it sweeps the rest of the
 * backlog too, which is why the answer URL carries the call rather than a fixed
 * script.
 */
export async function placeCaseCall(
  ctx: VoiceContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  purpose: CallPurpose = callPurposeFor(caseRow),
) {
  if (!ctx.settings.sendingEnabled) return { placed: false as const, reason: 'Sending is switched off for this customer' };
  if (employee.callOptOut) return { placed: false as const, reason: 'Employee has opted out of calls' };
  if (!employee.mobileE164) return { placed: false as const, reason: 'No mobile number on record' };

  // Keypad or conversation, per this employee, falling back to the customer's
  // default. Without an agent provider configured there is only one answer.
  const wantsAgent = (employee.callMode ?? ctx.settings.callMode) === 'agent';
  const provider = wantsAgent && ctx.voiceAgent ? ctx.voiceAgent : ctx.voice;

  const [call] = await ctx.tx
    .insert(calls)
    .values({
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      employeeId: employee.id,
      provider: provider.name,
      purpose,
      fromNumber: ctx.settings.callerId ?? undefined,
      toNumber: employee.mobileE164,
      attempt: caseRow.callAttempts + 1,
      status: 'queued',
      transcript: [],
    })
    .returning();

  const from = ctx.settings.callerId ?? process.env.PLIVO_FROM_NUMBER ?? '';
  try {
    const result = await provider.placeCall({
      to: `+${employee.mobileE164}`,
      from,
      answerUrl: `${ctx.baseUrl}/api/voice/answer?call=${call!.id}`,
      statusUrl: `${ctx.baseUrl}/api/voice/status?call=${call!.id}`,
      // 30 seconds is about five rings, which is easy to miss on a mobile.
      ringTimeoutSeconds: 45,
      caseId: caseRow.id,
    });

    await ctx.tx
      .update(calls)
      .set({ providerCallId: result.providerCallId, status: result.simulated ? 'simulated' : 'ringing', startedAt: new Date() })
      .where(eq(calls.id, call!.id));

    // A reminder call must not drag the case back to `asked`: the date has been
    // answered, and only the action is outstanding.
    await ctx.tx
      .update(cases)
      .set({
        ...(purpose === 'first_contact'
          ? { status: 'asked' as const, askedAt: caseRow.askedAt ?? new Date() }
          : { followUpSentAt: caseRow.followUpSentAt ?? new Date() }),
        channel: 'voice',
        callAttempts: caseRow.callAttempts + 1,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseRow.id));

    await ctx.tx.insert(usageEvents).values({
      tenantId: ctx.tenantId,
      kind: 'voice_minute',
      channel: 'voice',
      meta: { callId: call!.id, simulated: result.simulated },
    });

    return { placed: true as const, callId: call!.id, providerCallId: result.providerCallId, simulated: result.simulated };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await ctx.tx.update(calls).set({ status: 'failed', error: reason, endedAt: new Date() }).where(eq(calls.id, call!.id));
    await ctx.tx.update(cases).set({ error: reason, updatedAt: new Date() }).where(eq(cases.id, caseRow.id));
    return { placed: false as const, reason };
  }
}

/** What the agent says the moment the call connects. */
export async function openingTurn(ctx: VoiceContext, callId: string): Promise<CallTurn> {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
  if (!call) return { speak: spokenHandover(), nextCaseId: null, done: true };

  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, call.employeeId) });
  const target = call.caseId ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, call.caseId) }) : null;
  if (!employee || !target) return { speak: spokenHandover(), nextCaseId: null, done: true };

  await ctx.tx.update(calls).set({ status: 'in_progress' }).where(eq(calls.id, callId));

  const greeting = callGreeting(employee.fullName, ctx.companyName);

  if (call.purpose === 'follow_up') {
    // The reminder only makes sense for a date that was answered. If HR has
    // since reopened it, fall through to the first question instead of asking
    // about an action nobody was ever given.
    if (target.replyOption) {
      const outstanding = await pendingFollowUps(ctx, employee.id);
      const question = followUpPrompt(target.replyOption as OptionNumber, spokenFor(target), styleOf(call));
      await appendTurn(ctx, callId, 'agent', `${greeting} ${question}`);
      return {
        speak: question,
        intro: `${greeting} ${followUpBacklogOpening(outstanding.length)}`.trim(),
        nextCaseId: target.id,
        done: false,
      };
    }
  }

  const outstanding = await pending(ctx, employee.id);
  const question = datePrompt(spokenFor(target), styleOf(call));
  const intro = [greeting, callBacklogOpening(outstanding.length)].filter(Boolean).join(' ');

  await appendTurn(ctx, callId, 'agent', `${intro} ${question}`);
  return { speak: question, intro, nextCaseId: target.id, done: false };
}

/** Said once when more than one date is waiting on its action. */
function followUpBacklogOpening(count: number): string {
  if (count <= 1) return '';
  return `We are checking ${count} days with you.`;
}

/**
 * Handles one answer and decides what comes next.
 *
 * The call works the same way as the WhatsApp chain: answer this date, then the
 * summary, then the next date, until the backlog is cleared or they hang up.
 */
export async function handleTurn(
  ctx: VoiceContext,
  callId: string,
  caseId: string,
  input: CallTurnInput,
): Promise<CallTurn> {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
  const caseRow = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId) });
  if (!call || !caseRow) return { speak: spokenHandover(), nextCaseId: null, done: true };

  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
  if (!employee) return { speak: spokenHandover(), nextCaseId: null, done: true };

  await appendTurn(ctx, callId, 'employee', input.digits ? `pressed ${input.digits}` : (input.speech ?? '(silence)'));

  if (call.purpose === 'follow_up' && caseRow.replyOption) {
    return followUpTurn(ctx, call, caseRow, employee, input);
  }

  // Keypad first, exactly as agreed; speech is understood the same way a typed
  // WhatsApp reply is, through the same classifier.
  let option = optionFromDigits(input.digits);
  let usedSpeech = false;
  if (!option && input.speech?.trim()) {
    const classified = await classifyReply(input.speech, {
      dateLabel: dateLabel(caseRow.attDate, caseRow.meaning as Meaning),
      language: employee.language ?? ctx.settings.defaultLanguage,
      tenantModelOverride: ctx.settings.modelOverrides?.classify_reply,
    });
    option = classified.option;
    usedSpeech = true;
    if (classified.intent === 'needs_help') {
      await ctx.tx
        .update(cases)
        .set({ status: 'needs_hr', needsHrReason: 'Asked for help on the call', updatedAt: new Date() })
        .where(eq(cases.id, caseRow.id));
      await appendTurn(ctx, callId, 'agent', spokenHandover());
      await finishCall(ctx, callId, 'needs_help');
      return { speak: spokenHandover(), nextCaseId: null, done: true };
    }
  }

  if (!option) {
    const attempts = (call.transcript ?? []).filter((t) => t.role === 'agent' && t.text.startsWith('Sorry')).length;
    if (attempts >= 1) {
      await appendTurn(ctx, callId, 'agent', spokenHandover());
      await finishCall(ctx, callId, 'needs_help');
      return { speak: spokenHandover(), nextCaseId: null, done: true };
    }
    const style = styleOf(call);
    const question = datePrompt(spokenFor(caseRow), style);
    await appendTurn(ctx, callId, 'agent', `${spokenNotUnderstood(style)} ${question}`);
    return { speak: question, intro: spokenNotUnderstood(style), nextCaseId: caseId, done: false, retry: true };
  }

  await recordAnswer(ctx, caseRow, option, usedSpeech ? { intent: 'was_absent', option, confidence: 1, source: 'model' } : undefined);
  await recordSpokenMessage(ctx, caseRow, employee, option);

  const outstanding = await pending(ctx, employee.id, caseRow.id);
  const cleared = (call.transcript ?? []).filter((t) => t.role === 'agent' && t.text.startsWith('Thank you.')).length + 1;

  // A tenant may cap how long one call runs; 0 means carry on until cleared.
  const cap = ctx.settings.maxDatesPerCall;
  const reachedCap = cap > 0 && cleared >= cap;

  if (!outstanding.length || reachedCap) {
    const closing = `${spokenGuidance(option, spokenFor(caseRow))} ${spokenClosing(cleared, outstanding.length)}`;
    await appendTurn(ctx, callId, 'agent', closing);
    await finishCall(ctx, callId, outstanding.length ? 'not_completed' : 'completed_confirmed');
    return { speak: closing, nextCaseId: null, done: true };
  }

  const next = outstanding[0]!;
  const intro = [spokenGuidance(option, spokenFor(caseRow)), spokenBacklogSummary(outstanding.length)].join(' ');
  const question = datePrompt(spokenFor(next), styleOf(call));
  await appendTurn(ctx, callId, 'agent', `${intro} ${question}`);
  return { speak: question, intro, nextCaseId: next.id, done: false };
}

/**
 * One answer to the day-2 reminder, and what follows it.
 *
 * It sweeps the same way the first call does: answer this date's action, then
 * the next date whose action is still open, until the employee is clear.
 */
async function followUpTurn(
  ctx: VoiceContext,
  call: CallRow,
  caseRow: CaseRow,
  employee: EmployeeRow,
  input: CallTurnInput,
): Promise<CallTurn> {
  const callId = call.id;
  let choice: FollowUpChoice | null = followUpChoiceFromDigits(input.digits);

  // The reminder is a yes/no question, so it is read as one. Only when the rules
  // cannot tell does the classifier get a look, and then solely to catch someone
  // asking for a person.
  if (!choice && input.speech?.trim()) {
    choice = followUpChoiceFromSpeech(input.speech);
    if (!choice) {
      const classified = await classifyReply(input.speech, {
        dateLabel: dateLabel(caseRow.attDate, caseRow.meaning as Meaning),
        language: employee.language ?? ctx.settings.defaultLanguage,
        tenantModelOverride: ctx.settings.modelOverrides?.classify_reply,
      });
      if (classified.intent === 'needs_help') choice = 'help';
    }
  }

  if (!choice) {
    const asked = (call.transcript ?? []).filter((t) => t.role === 'agent' && t.text.startsWith('Sorry')).length;
    if (asked >= 1) {
      await appendTurn(ctx, callId, 'agent', spokenHandover());
      await finishCall(ctx, callId, 'needs_help');
      return { speak: spokenHandover(), nextCaseId: null, done: true };
    }
    const style = styleOf(call);
    const question = followUpPrompt(caseRow.replyOption as OptionNumber, spokenFor(caseRow), style);
    await appendTurn(ctx, callId, 'agent', `${spokenFollowUpNotUnderstood(style)} ${question}`);
    return {
      speak: question,
      intro: spokenFollowUpNotUnderstood(style),
      nextCaseId: caseRow.id,
      done: false,
      retry: true,
    };
  }

  await recordFollowUpChoice(ctx, caseRow, choice);
  await recordSpokenFollowUp(ctx, caseRow, employee, choice);

  const acknowledgement = spokenFollowUpAcknowledgement(choice, spokenFor(caseRow));

  // Asking for help ends the call: HR takes it from here.
  if (choice === 'help') {
    await appendTurn(ctx, callId, 'agent', acknowledgement);
    await finishCall(ctx, callId, 'needs_help');
    return { speak: acknowledgement, nextCaseId: null, done: true };
  }

  const outstanding = await pendingFollowUps(ctx, employee.id, caseRow.id);
  const cap = ctx.settings.maxDatesPerCall;
  const cleared = (call.transcript ?? []).filter((t) => t.role === 'agent' && t.text.startsWith('Thank you')).length + 1;
  const reachedCap = cap > 0 && cleared >= cap;

  if (!outstanding.length || reachedCap) {
    const closing = `${acknowledgement} ${spokenFollowUpClosing(outstanding.length)}`;
    await appendTurn(ctx, callId, 'agent', closing);
    await finishCall(ctx, callId, outstanding.length ? 'not_completed' : 'completed_confirmed');
    return { speak: closing, nextCaseId: null, done: true };
  }

  const next = outstanding[0]!;
  const intro = `${acknowledgement} ${spokenFollowUpSummary(outstanding.length)}`;
  const question = followUpPrompt(next.replyOption as OptionNumber, spokenFor(next), styleOf(call));
  await appendTurn(ctx, callId, 'agent', `${intro} ${question}`);
  return { speak: question, intro, nextCaseId: next.id, done: false };
}

/** The transcript is the call's equivalent of a chat history. */
async function appendTurn(ctx: VoiceContext, callId: string, role: 'agent' | 'employee', text: string) {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
  const transcript = [...(call?.transcript ?? []), { role, text, at: new Date().toISOString() }];
  await ctx.tx.update(calls).set({ transcript }).where(eq(calls.id, callId));
}

/** Mirrors what was said into the case's message history, so HR sees one story. */
async function recordSpokenMessage(ctx: VoiceContext, caseRow: CaseRow, employee: EmployeeRow, option: OptionNumber) {
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  await ctx.tx.insert(messages).values([
    {
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      direction: 'inbound',
      channel: 'voice',
      kind: 'voice',
      status: 'received',
      waId: employee.mobileE164,
      body: `Answered option ${option} on the call`,
    },
    {
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      direction: 'outbound',
      channel: 'voice',
      kind: 'voice',
      status: 'sent',
      waId: employee.mobileE164,
      body: spokenGuidance(option, label),
    },
  ]);
}

/** The reminder's answer, mirrored into the case history like a chat message. */
async function recordSpokenFollowUp(
  ctx: VoiceContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  choice: FollowUpChoice,
) {
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  await ctx.tx.insert(messages).values([
    {
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      direction: 'inbound',
      channel: 'voice',
      kind: 'voice',
      status: 'received',
      waId: employee.mobileE164,
      body: `Answered the reminder on the call: ${choice.replace('_', ' ')}`,
    },
    {
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      direction: 'outbound',
      channel: 'voice',
      kind: 'voice',
      status: 'sent',
      waId: employee.mobileE164,
      body: followUpAcknowledgement(choice, label),
    },
  ]);
}

export async function finishCall(
  ctx: VoiceContext,
  callId: string,
  outcome: 'completed_confirmed' | 'not_completed' | 'needs_help' | 'no_answer' | 'busy' | 'failed',
  meta: { durationSeconds?: number } = {},
) {
  await ctx.tx
    .update(calls)
    .set({
      status: outcome === 'no_answer' || outcome === 'busy' || outcome === 'failed' ? 'failed' : 'completed',
      outcome,
      endedAt: new Date(),
      durationSeconds: meta.durationSeconds,
    })
    .where(eq(calls.id, callId));
}

/**
 * Closes a call that was picked up, once the line has dropped.
 *
 * The conversation normally ends itself, and that verdict stands. What is left
 * here is the call that was answered but never got an answer out of the
 * employee - someone who picked up and said nothing, or hung up mid-question.
 * That is not a confirmation, and recording it as one would quietly overstate
 * what the agent achieved.
 */
export async function closeAnsweredCall(ctx: VoiceContext, callId: string, durationSeconds: number) {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
  if (!call) return;

  if (call.outcome) {
    await ctx.tx.update(calls).set({ durationSeconds, endedAt: new Date() }).where(eq(calls.id, callId));
    return;
  }

  // `no_answer` would be wrong here - the phone was picked up. Nothing was
  // settled on it, which is what `not_completed` says.
  await finishCall(ctx, callId, 'not_completed', { durationSeconds });
}

/**
 * A missed call is treated exactly like an ignored WhatsApp message: the date
 * stays pending, nothing is retried, and it is swept up by the next call.
 */
export async function recordNoAnswer(ctx: VoiceContext, callId: string, status: 'no_answer' | 'busy' | 'failed') {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
  await finishCall(ctx, callId, status);
  if (call?.caseId) {
    await ctx.tx
      .update(cases)
      .set({ updatedAt: new Date() })
      .where(and(eq(cases.id, call.caseId), inArray(cases.status, [...UNANSWERED])));
  }
}
