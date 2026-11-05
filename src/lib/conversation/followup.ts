import { and, asc, eq, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { cases, employees } from '@/db/schema';
import type { Meaning } from '@/lib/mapping/meanings';
import {
  canSend,
  chainNextPending,
  deliver,
  getConversation,
  sendButtons,
  sendPlainText,
  windowOpen,
  type CaseRow,
  type EmployeeRow,
  type EngineContext,
} from './engine';
import { followUpChannel } from '@/lib/channel';
import { managerFor, requestManagerApproval } from '@/lib/approvals';
import { recordFollowUpChoice } from './follow-up-state';
import { placeCaseCall, type VoiceContext } from '@/lib/voice/session';
import { today } from '@/lib/dates';
import { instructionFor, OUTCOMES, type LeaveChoice, type OutcomeCode } from './outcomes';
import { writtenFacts } from './sheet';
import {
  dateLabel,
  DAYS_TO_ACT,
  fillTemplate,
  FINAL_NOTICE_TEMPLATE,
  FINAL_NOTICE_TEMPLATE_BODY,
  firstName,
  FOLLOW_UP_TEMPLATE,
  FOLLOW_UP_TEMPLATE_BODY,
  followUpAcknowledgement,
  followUpMessage,
  followUpSelectionId,
  type FollowUpChoice,
  type OptionNumber,
} from './flow';

/**
 * Reminders need to know how to reach people. On WhatsApp the engine context is
 * enough; a call also needs the voice provider, which a tenant may not have.
 */
type FollowUpContext = EngineContext & Partial<Pick<VoiceContext, 'voice' | 'baseUrl'>>;

type NotedOutcome = { code: OutcomeCode; leaveChoice: LeaveChoice | null; note?: string | null };
const notedOutcome = (caseRow: CaseRow) => (caseRow.context as { outcome?: NotedOutcome }).outcome;

/** Which follow-up this case is due next, and whether it is the last one. */
export function nextFollowUp(caseRow: CaseRow, settings: { maxFollowUps: number }) {
  const number = caseRow.followUpCount + 1;
  return { number, final: number >= settings.maxFollowUps };
}

/** Sends one reminder on WhatsApp, with the three buttons it is answered by. */
async function sendReminder(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, at: Date) {
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const reminder = followUpMessage(caseRow.replyOption as OptionNumber, label);
  const { buttons } = reminder;
  let body = reminder.body;

  // When the flow sheet settled it, the reminder repeats exactly what they were
  // told - with the deadline as it was given, counted from the day they answered.
  const outcome = notedOutcome(caseRow);
  if (outcome && (caseRow.replyOption === 1 || caseRow.replyOption === 2)) {
    const answeredOn = caseRow.answeredAt ? today(ctx.settings.timezone, caseRow.answeredAt) : undefined;
    const facts = await writtenFacts(ctx, caseRow, employee, answeredOn);
    body = `Reminder about ${label}: "${instructionFor(outcome.code, outcome.leaveChoice, facts)}" Have you done it?`;
  }
  const ids: FollowUpChoice[] = ['done', 'not_done', 'help'];

  // WhatsApp refuses buttons once the 24-hour window has closed, as it usually has by now.
  if (!windowOpen(await getConversation(ctx, employee.id), at)) {
    const variables = [firstName(employee.fullName), body];
    const preview = fillTemplate(FOLLOW_UP_TEMPLATE_BODY, variables);
    await deliver(
      ctx,
      employee,
      {
        kind: 'template',
        to: employee.mobileE164!,
        templateName: FOLLOW_UP_TEMPLATE,
        language: 'en',
        variables,
        buttonPayloads: ids.map((choice) => followUpSelectionId(caseRow.id, choice)),
        preview,
      },
      { caseId: caseRow.id, kind: 'template', body: preview, templateName: FOLLOW_UP_TEMPLATE },
    );
    return;
  }

  await sendButtons(
    ctx,
    employee,
    body,
    buttons.map((title, index) => ({ id: followUpSelectionId(caseRow.id, ids[index]!), title })),
    caseRow.id,
  );
}

/** What a case was chasing, for the notice and the manager. Older answers noted no outcome. */
function chasedOutcome(caseRow: CaseRow): OutcomeCode {
  const noted = notedOutcome(caseRow)?.code;
  if (noted && OUTCOMES[noted].application) return noted;
  return caseRow.replyOption === 2 || caseRow.replyOption === 4 ? 'regularisation_already_sent' : 'leave_not_applied';
}

/** What the final notice names: the thing not done, and who the case now goes to. */
export async function finalNoticeFacts(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow) {
  const manager = await managerFor(ctx.tx, ctx.tenantId, employee);
  const named = manager && manager.fullName !== 'Manager' ? `your manager, ${firstName(manager.fullName)}` : 'your manager';
  return { what: OUTCOMES[chasedOutcome(caseRow)].application!.what, transferee: manager ? named : 'HR' };
}

/** The final notice on WhatsApp. Nothing to answer: only doing it, or the manager, ends it. */
export async function sendFinalNotice(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, at = new Date()) {
  const { what, transferee } = await finalNoticeFacts(ctx, caseRow, employee);
  const date = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const variables = [firstName(employee.fullName), what, date, transferee];
  const preview = fillTemplate(FINAL_NOTICE_TEMPLATE_BODY, variables);
  if (windowOpen(await getConversation(ctx, employee.id), at)) return sendPlainText(ctx, employee, preview, caseRow.id);
  return deliver(
    ctx,
    employee,
    { kind: 'template', to: employee.mobileE164!, templateName: FINAL_NOTICE_TEMPLATE, language: 'en', variables, preview },
    { caseId: caseRow.id, kind: 'template', body: preview, templateName: FINAL_NOTICE_TEMPLATE },
  );
}

/**
 * Counts a follow-up as gone and sets the next one's clock. After the last, the
 * case moves to the manager, or to HR when the file names none.
 */
async function recordFollowUpSent(ctx: FollowUpContext, caseRow: CaseRow, employee: EmployeeRow, at: Date) {
  const { number, final } = nextFollowUp(caseRow, ctx.settings);
  const channel = followUpChannel(employee, ctx.settings, number);
  await ctx.tx
    .update(cases)
    .set({
      followUpCount: number,
      followUpSentAt: at,
      followUpReply: null,
      followUpDueAt: final ? null : new Date(at.getTime() + DAYS_TO_ACT * 86_400_000),
      updatedAt: at,
    })
    .where(eq(cases.id, caseRow.id));
  if (!final) return;

  const outcome = notedOutcome(caseRow);
  await requestManagerApproval(ctx, caseRow, employee, {
    code: chasedOutcome(caseRow),
    choice: outcome?.leaveChoice ?? null,
    stage: 'overdue',
    note: outcome?.note ?? null,
    via: channel === 'voice' ? 'call' : 'whatsapp',
    followUps: number,
  });
}

/**
 * Sends the follow-up this case is due, the way its level is set for the customer.
 * A provider refusing a message is thrown, and nothing is counted.
 */
export async function sendFollowUp(
  ctx: FollowUpContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  at = new Date(),
): Promise<{ reached: true; simulated?: boolean } | { reached: false; reason: string }> {
  const { number, final } = nextFollowUp(caseRow, ctx.settings);
  let simulated: boolean | undefined;

  if (followUpChannel(employee, ctx.settings, number) === 'voice') {
    if (!ctx.voice || !ctx.baseUrl) return { reached: false, reason: 'No voice provider configured' };
    const callMode = ctx.settings.followUpContacts[number - 1]?.callMode;
    const result = await placeCaseCall(ctx as VoiceContext, caseRow, employee, final ? 'final_notice' : 'follow_up', callMode);
    if (!result.placed) return { reached: false, reason: result.reason };
    simulated = result.simulated;
  } else {
    const block = canSend(ctx, employee);
    if (block.blocked) return { reached: false, reason: block.reason };
    if (final) await sendFinalNotice(ctx, caseRow, employee, at);
    else await sendReminder(ctx, caseRow, employee, at);
  }

  await recordFollowUpSent(ctx, caseRow, employee, at);
  return { reached: true, simulated };
}

/**
 * Who an upload brings a follow-up to: anyone who answered and has still not
 * acted, once the day they were last in touch is over. A second upload on the
 * same day sends nobody a second follow-up.
 */
export const followUpDueOnUpload = (timezone: string, at: Date) =>
  and(
    eq(cases.status, 'answered'),
    isNotNull(cases.followUpDueAt),
    isNotNull(cases.replyOption),
    sql`(greatest(${cases.answeredAt}, ${cases.followUpSentAt}) at time zone ${timezone})::date < ${today(timezone, at)}`,
  );

/** The follow-ups HR sends from the dashboard: those whose day to act has passed. */
export const sendDueFollowUps = (ctx: FollowUpContext, at = new Date()) =>
  sendFollowUps(ctx, and(eq(cases.status, 'answered'), lte(cases.followUpDueAt, at)), at);

/** One person's follow-ups at their turn after an upload. */
export const sendFollowUpsAfterUpload = (ctx: FollowUpContext, employeeId: string, at = new Date()) =>
  sendFollowUps(ctx, and(followUpDueOnUpload(ctx.settings.timezone, at), eq(cases.employeeId, employeeId)), at);

/**
 * Nothing sweeps these on a clock: HR sends them, or an upload does.
 *
 * They exist only for dates the employee answered and has not yet acted on - an
 * ignored question is never chased. Anyone who has since sorted it out is no
 * longer `answered`, so they hear nothing.
 *
 * The reminder goes out the way its level is set. On
 * WhatsApp that is one message per date; on the phone it is one call per
 * person, which then works through their dates the way the first call does -
 * nobody should be rung five times in a morning. The dates that call covers
 * each count as followed up, picked up or not, as an ignored message would.
 */
async function sendFollowUps(ctx: FollowUpContext, which: SQL | undefined, at: Date) {
  const due = await ctx.tx
    .select()
    .from(cases)
    .where(and(eq(cases.tenantId, ctx.tenantId), which))
    // Oldest absence first, not earliest reminder. Within one person the two
    // differ - a call answers the newest date before sweeping backwards, so the
    // newest date's reminder falls due first - and the employee should be rung
    // about their oldest outstanding day, as everywhere else in this flow.
    .orderBy(asc(cases.attDate))
    .limit(200);

  let sent = 0;
  let called = 0;
  const skipped: string[] = [];
  // A reminder and a final notice are different calls, so one person may get one of each.
  const rungAlready = new Set<string>();

  for (const caseRow of due) {
    const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
    if (!employee) continue;

    const block = canSend(ctx, employee);
    if (block.blocked) {
      skipped.push(block.reason);
      continue;
    }
    if (!caseRow.replyOption) continue;

    const next = nextFollowUp(caseRow, ctx.settings);
    const onCall = followUpChannel(employee, ctx.settings, next.number) === 'voice';
    const callKey = `${employee.id}:${next.final}`;
    if (onCall && rungAlready.has(callKey)) {
      await recordFollowUpSent(ctx, caseRow, employee, at);
      continue;
    }

    try {
      const result = await sendFollowUp(ctx, caseRow, employee, at);
      if (!result.reached) {
        skipped.push(result.reason);
      } else if (onCall) {
        rungAlready.add(callKey);
        called++;
      } else {
        sent++;
      }
    } catch (error) {
      // One refused message, such as a template Meta has not approved, must not
      // lose the rest of the batch. It is tried again at the next sweep.
      const reason = (error as Error).message;
      await ctx.tx.update(cases).set({ error: reason, updatedAt: new Date() }).where(eq(cases.id, caseRow.id));
      skipped.push(reason);
    }
  }

  return { due: due.length, sent, called, skipped };
}

/** What the employee said to the reminder decides whether the next follow-up still goes. */
export async function handleFollowUpResponse(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  choice: FollowUpChoice,
) {
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  // An old button, tapped after the case went to the manager or was closed.
  if (caseRow.status !== 'answered') {
    await sendPlainText(ctx, employee, `${label} has already moved on, so please speak to your manager or HR about it.`, caseRow.id);
    return { choice };
  }
  await recordFollowUpChoice(ctx, caseRow, choice);

  await sendPlainText(ctx, employee, followUpAcknowledgement(choice, label), caseRow.id);
  if (choice === 'done') await chainNextPending(ctx, employee, caseRow.id);
  return { choice };
}
