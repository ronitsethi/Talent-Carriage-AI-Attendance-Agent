import { and, desc, eq, inArray } from 'drizzle-orm';
import { actions, approvals, calls, cases, employees, managers, usageEvents } from '@/db/schema';
import type { Meaning } from '@/lib/mapping/meanings';
import { halfOfDay } from '@/lib/mapping/meanings';
import { dateLabel, firstName } from '@/lib/conversation/flow';
import { spokenDate } from '@/lib/conversation/voice-script';
import type { CaseRow, EmployeeRow } from '@/lib/conversation/engine';
import type { ApplicationStage } from '@/lib/conversation/outcomes';
import type { VoiceContext, CallRow, CallTurn } from './session';

/**
 * The two calls about a manager's approval.
 *
 * `manager_approval` rings a manager set to Call: who applied, for what and
 * why, then "press 1, or say yes, once you have approved it in your HRMS; 2, or
 * no, if you are not approving it". The words are fixed rather than written by
 * a model - it is one question, asked the same way every time.
 *
 * `approval_outcome` rings an employee set to Call with the manager's decision,
 * and hangs up. It always goes by the keypad line, whatever the employee's call
 * style: it is one sentence, not a conversation, and that line says plainly when
 * nobody picked up - which is what lets a missed call fall back to WhatsApp, so
 * the decision always reaches them.
 *
 * Both are filed against the case and its employee, as every call is; the
 * number rung is the manager's for the first.
 */

export type ApprovalCallPurpose = 'manager_approval' | 'approval_outcome';
export const APPROVAL_CALL_PURPOSES: ApprovalCallPurpose[] = ['manager_approval', 'approval_outcome'];

const spokenFor = (row: { attDate: string; meaning: string }) =>
  spokenDate(row.attDate, halfOfDay(row.meaning as Meaning) as 'first' | 'second' | null);

/** Rings `to` about this case. The keypad line unless `agent` asks for the talking one. */
export async function placeApprovalCall(
  ctx: VoiceContext,
  purpose: ApprovalCallPurpose,
  caseRow: CaseRow,
  employee: EmployeeRow,
  to: string,
  agent: boolean,
): Promise<{ placed: true; callId: string } | { placed: false; reason: string }> {
  if (!ctx.settings.sendingEnabled) return { placed: false, reason: 'Sending is switched off for this customer' };
  const provider = agent && ctx.voiceAgent ? ctx.voiceAgent : ctx.voice;
  const [call] = await ctx.tx
    .insert(calls)
    .values({
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      employeeId: employee.id,
      provider: provider.name,
      purpose,
      fromNumber: ctx.settings.callerId ?? undefined,
      toNumber: to,
      status: 'queued',
      transcript: [],
    })
    .returning();
  try {
    const result = await provider.placeCall({
      to: `+${to}`,
      from: ctx.settings.callerId ?? process.env.PLIVO_FROM_NUMBER ?? '',
      answerUrl: `${ctx.baseUrl}/api/voice/answer?call=${call!.id}`,
      statusUrl: `${ctx.baseUrl}/api/voice/status?call=${call!.id}`,
      ringTimeoutSeconds: 45,
      caseId: caseRow.id,
    });
    await ctx.tx
      .update(calls)
      .set({ providerCallId: result.providerCallId, status: result.simulated ? 'simulated' : 'ringing', startedAt: new Date() })
      .where(eq(calls.id, call!.id));
    await ctx.tx.insert(usageEvents).values({
      tenantId: ctx.tenantId,
      kind: 'voice_minute',
      channel: 'voice',
      meta: { callId: call!.id, purpose, simulated: result.simulated },
    });
    return { placed: true, callId: call!.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await ctx.tx.update(calls).set({ status: 'failed', error: reason, endedAt: new Date() }).where(eq(calls.id, call!.id));
    return { placed: false, reason };
  }
}

/** The request a manager call is about: the latest one on this case for the number rung. */
async function requestFor(ctx: VoiceContext, call: CallRow) {
  if (!call.caseId || !call.toNumber) return null;
  const [row] = await ctx.tx
    .select({ approval: approvals, action: actions, manager: managers })
    .from(approvals)
    .innerJoin(actions, eq(actions.id, approvals.actionId))
    .innerJoin(managers, eq(managers.id, approvals.approverManagerId))
    .where(and(eq(actions.caseId, call.caseId), eq(managers.mobileE164, call.toNumber)))
    .orderBy(desc(approvals.requestedAt))
    .limit(1);
  return row ?? null;
}

const STAGE_PHRASE: Record<ApplicationStage, string> = {
  applied: 'has applied',
  not_applied: 'has been asked to apply',
  apply_for_me: 'has asked us to apply',
};

/** What a manager call says, and the question it asks, in the style of the line it is on. */
async function managerScript(ctx: VoiceContext, call: CallRow) {
  const request = await requestFor(ctx, call);
  const caseRow = call.caseId ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, call.caseId) }) : null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, call.employeeId) });
  if (!request || !caseRow || !employee) return null;
  const inputs = request.action.inputs as { what: string; stage: ApplicationStage; leaveType?: string; reason?: string };
  const what = inputs.leaveType && inputs.what === 'leave' ? `${inputs.leaveType} leave` : inputs.what;
  const agentApplies = inputs.stage === 'apply_for_me' && Boolean(request.action.connector);
  const keypad = call.provider !== 'livekit';
  const intro =
    `Hello ${firstName(request.manager.fullName)}, this is the attendance assistant from ${ctx.companyName}. ` +
    `${employee.fullName} ${STAGE_PHRASE[inputs.stage] ?? 'has asked about'} ${what.replace(/HRMS/g, 'H R M S')} for ${spokenFor(caseRow)}.` +
    (inputs.reason ? ` The reason given is: ${inputs.reason}.` : '');
  const question = agentApplies
    ? keypad
      ? 'Press 1 to approve it, and we will apply it in the H R M S. Press 2 if you are not approving it.'
      : 'Do you approve it? Say yes, and we will apply it in the H R M S, or no if you are not approving it.'
    : keypad
      ? 'Press 1 once you have approved it in your H R M S. Press 2 if you are not approving it.'
      : 'Have you approved it in your H R M S? Please say yes once you have, or no if you are not approving it.';
  return { request, caseRow, employee, intro, question, keypad };
}

/** The decision the employee is told, from the latest request on the case. */
export async function decisionSentence(
  ctx: VoiceContext,
  caseId: string,
  spoken: boolean,
): Promise<{ sentence: string; employee: EmployeeRow; caseRow: CaseRow } | null> {
  const caseRow = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId) });
  if (!caseRow) return null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
  const [row] = await ctx.tx
    .select({ approval: approvals, action: actions, manager: managers })
    .from(approvals)
    .innerJoin(actions, eq(actions.id, approvals.actionId))
    .innerJoin(managers, eq(managers.id, approvals.approverManagerId))
    .where(and(eq(actions.caseId, caseId), inArray(approvals.decision, ['approved', 'rejected'])))
    .orderBy(desc(approvals.respondedAt))
    .limit(1);
  if (!row || !employee) return null;
  const inputs = row.action.inputs as { what: string; leaveType?: string };
  const what = inputs.leaveType && inputs.what === 'leave' ? inputs.leaveType : inputs.what;
  const date = spoken ? spokenFor(caseRow) : dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  return {
    sentence: outcomeSentence({
      approved: row.approval.decision === 'approved',
      manager: firstName(row.manager.fullName),
      what,
      date,
      applied: row.action.connector ? (row.action.status === 'executed' ? true : row.action.status === 'failed' ? false : null) : null,
      spoken,
    }),
    employee,
    caseRow,
  };
}

/**
 * The manager's decision, as the employee hears or reads it. `applied` is set
 * when the agent was to apply it in the HRMS: true once it has, false when the
 * HRMS refused.
 */
export function outcomeSentence(d: { approved: boolean; manager: string; what: string; date: string; applied: boolean | null; spoken?: boolean }): string {
  const hrms = d.spoken ? 'H R M S' : 'HRMS';
  const hr = d.spoken ? 'H R' : 'HR';
  if (!d.approved) return `${d.manager} did not approve your ${d.what} for ${d.date}. Please speak to ${d.manager} or ${hr} if you need to.`;
  if (d.applied === true) return `${d.manager} has approved your ${d.what} for ${d.date}, and it has been applied in the ${hrms}.`;
  if (d.applied === false) return `${d.manager} has approved your ${d.what} for ${d.date}, but it could not be applied automatically, so ${hr} will finish it.`;
  return `${d.manager} has approved your ${d.what} for ${d.date}.`;
}

async function say(ctx: VoiceContext, callId: string, role: 'agent' | 'employee', text: string) {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId), columns: { transcript: true } });
  const transcript = [...(call?.transcript ?? []), { role, text, at: new Date().toISOString() }];
  await ctx.tx.update(calls).set({ transcript }).where(eq(calls.id, callId));
}

/** The first thing either call says. */
export async function approvalOpening(ctx: VoiceContext, call: CallRow): Promise<CallTurn> {
  await ctx.tx.update(calls).set({ status: 'in_progress' }).where(eq(calls.id, call.id));
  if (call.purpose === 'approval_outcome') {
    const told = call.caseId ? await decisionSentence(ctx, call.caseId, true) : null;
    if (!told) return { speak: 'Goodbye.', nextCaseId: null, done: true };
    const text = `Hello ${firstName(told.employee.fullName)}, this is the attendance assistant from ${ctx.companyName}. ${told.sentence} Goodbye.`;
    await say(ctx, call.id, 'agent', text);
    await ctx.tx.update(calls).set({ outcome: 'completed_confirmed' }).where(eq(calls.id, call.id));
    return { speak: text, nextCaseId: null, done: true };
  }
  const script = await managerScript(ctx, call);
  if (!script) return { speak: 'Sorry, this request is no longer waiting. Goodbye.', nextCaseId: null, done: true };
  if (script.request.approval.decision !== 'pending') {
    const text = `${script.intro} This has already been ${script.request.approval.decision}. Thank you. Goodbye.`;
    await say(ctx, call.id, 'agent', text);
    return { speak: text, nextCaseId: null, done: true };
  }
  await say(ctx, call.id, 'agent', `${script.intro} ${script.question}`);
  return { speak: script.question, intro: script.intro, nextCaseId: script.caseRow.id, done: false };
}

/** What the manager pressed or said: a decision, or nothing that could be read as one. */
export function managerVerdict(input: { digits?: string; speech?: string }): 'approve' | 'reject' | null {
  if (input.digits === '1') return 'approve';
  if (input.digits === '2') return 'reject';
  const said = (input.speech ?? '').toLowerCase();
  if (/\b(no|nahi|nahin|not|reject|rejected|decline|mat)\b/.test(said)) return 'reject';
  if (/\b(yes|haan|han|ha|ji|approve|approved|done|ok|okay|kar diya|ho gaya)\b/.test(said)) return 'approve';
  return null;
}

/**
 * The manager's answer. A decision is recorded and the employee told; a second
 * answer that still is not one ends the call, and the request goes on WhatsApp.
 */
export async function approvalTurn(ctx: VoiceContext, call: CallRow, input: { digits?: string; speech?: string }): Promise<CallTurn> {
  const script = await managerScript(ctx, call);
  if (!script) return { speak: 'Goodbye.', nextCaseId: null, done: true };
  await say(ctx, call.id, 'employee', input.digits ? `pressed ${input.digits}` : input.speech?.trim() || '(silence)');

  const verdict = managerVerdict(input);
  if (verdict) {
    const { decideApproval } = await import('@/lib/approvals');
    await decideApproval(ctx, script.request.approval.id, verdict, script.request.manager.mobileE164, 'call');
    const text =
      verdict === 'approve'
        ? `Thank you. Noted as approved, and ${firstName(script.employee.fullName)} will be told. Goodbye.`
        : `Thank you. Noted as not approved, and ${firstName(script.employee.fullName)} will be told. Goodbye.`;
    await say(ctx, call.id, 'agent', text);
    await ctx.tx.update(calls).set({ outcome: 'completed_confirmed' }).where(eq(calls.id, call.id));
    return { speak: text, nextCaseId: null, done: true };
  }

  const tries = (call.transcript ?? []).filter((t) => t.role === 'agent' && t.text.startsWith('Sorry')).length;
  if (tries >= 1) {
    const text = 'No problem. We will send you the details on WhatsApp instead. Goodbye.';
    await say(ctx, call.id, 'agent', text);
    return { speak: text, nextCaseId: null, done: true };
  }
  const sorry = script.keypad ? 'Sorry, I did not catch that.' : 'Sorry, I did not quite catch that.';
  await say(ctx, call.id, 'agent', `${sorry} ${script.question}`);
  return { speak: script.question, intro: sorry, nextCaseId: script.caseRow.id, done: false, retry: true };
}

/**
 * Once a call about an approval is over, whatever it did not get across goes on
 * WhatsApp: a request the manager did not decide, or a decision the employee
 * did not pick up for.
 */
export async function afterApprovalCall(ctx: VoiceContext, call: CallRow, answered: boolean) {
  if (call.purpose === 'manager_approval') {
    const request = await requestFor(ctx, call);
    if (request?.approval.decision === 'pending') {
      const { sendApprovalRequest } = await import('@/lib/approvals');
      await sendApprovalRequest(ctx, request.approval.id, 'whatsapp');
    }
    return;
  }
  if (call.purpose === 'approval_outcome' && !answered && call.caseId) {
    const { tellEmployeeOnWhatsApp } = await import('@/lib/approvals');
    await tellEmployeeOnWhatsApp(ctx, call.caseId);
  }
}
