import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { calls, cases, employees, messages, usageEvents } from '@/db/schema';
import { classifyReply } from '@/lib/conversation/classify';
import { dateLabel, type OptionNumber } from '@/lib/conversation/flow';
import {
  callBacklogOpening,
  callGreeting,
  datePrompt,
  optionFromDigits,
  spokenBacklogSummary,
  spokenClosing,
  spokenDate,
  spokenGuidance,
  spokenHandover,
  spokenNotUnderstood,
} from '@/lib/conversation/voice-script';
import { recordAnswer, UNANSWERED, type CaseRow, type EmployeeRow, type EngineContext } from '@/lib/conversation/engine';
import { halfOfDay, type Meaning } from '@/lib/mapping/meanings';
import type { CallTurnInput, VoiceProvider } from './types';

export type VoiceContext = EngineContext & { voice: VoiceProvider; baseUrl: string };
export type CallRow = typeof calls.$inferSelect;

/** One spoken turn: what the agent says, and what happens next. */
export type CallTurn = {
  speak: string;
  /** The case the next keypad press belongs to; null when the call is ending. */
  nextCaseId: string | null;
  done: boolean;
  /** True when the same question should be asked again after a bad input. */
  retry?: boolean;
};

const spokenFor = (row: { attDate: string; meaning: string }) =>
  spokenDate(row.attDate, halfOfDay(row.meaning as Meaning) as 'first' | 'second' | null);

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
 * Places the call for one date.
 *
 * The call is *about* that date, but once answered it sweeps the rest of the
 * backlog too, which is why the answer URL carries the call rather than a fixed
 * script.
 */
export async function placeCaseCall(ctx: VoiceContext, caseRow: CaseRow, employee: EmployeeRow) {
  if (!ctx.settings.sendingEnabled) return { placed: false as const, reason: 'Sending is switched off for this customer' };
  if (employee.callOptOut) return { placed: false as const, reason: 'Employee has opted out of calls' };
  if (!employee.mobileE164) return { placed: false as const, reason: 'No mobile number on record' };

  const [call] = await ctx.tx
    .insert(calls)
    .values({
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      employeeId: employee.id,
      provider: ctx.voice.name,
      fromNumber: ctx.settings.callerId ?? undefined,
      toNumber: employee.mobileE164,
      attempt: caseRow.callAttempts + 1,
      status: 'queued',
      transcript: [],
    })
    .returning();

  const from = ctx.settings.callerId ?? process.env.PLIVO_FROM_NUMBER ?? '';
  try {
    const result = await ctx.voice.placeCall({
      to: `+${employee.mobileE164}`,
      from,
      answerUrl: `${ctx.baseUrl}/api/voice/answer?call=${call!.id}`,
      statusUrl: `${ctx.baseUrl}/api/voice/status?call=${call!.id}`,
      caseId: caseRow.id,
    });

    await ctx.tx
      .update(calls)
      .set({ providerCallId: result.providerCallId, status: result.simulated ? 'simulated' : 'ringing', startedAt: new Date() })
      .where(eq(calls.id, call!.id));

    await ctx.tx
      .update(cases)
      .set({
        status: 'asked',
        channel: 'voice',
        askedAt: caseRow.askedAt ?? new Date(),
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

  const outstanding = await pending(ctx, employee.id);
  const opening = [
    callGreeting(employee.fullName, ctx.companyName),
    callBacklogOpening(outstanding.length),
    datePrompt(spokenFor(target)),
  ]
    .filter(Boolean)
    .join(' ');

  await appendTurn(ctx, callId, 'agent', opening);
  return { speak: opening, nextCaseId: target.id, done: false };
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
    const retry = `${spokenNotUnderstood()} ${datePrompt(spokenFor(caseRow))}`;
    await appendTurn(ctx, callId, 'agent', retry);
    return { speak: retry, nextCaseId: caseId, done: false, retry: true };
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
  const speak = [
    spokenGuidance(option, spokenFor(caseRow)),
    spokenBacklogSummary(outstanding.length),
    datePrompt(spokenFor(next)),
  ].join(' ');
  await appendTurn(ctx, callId, 'agent', speak);
  return { speak, nextCaseId: next.id, done: false };
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
