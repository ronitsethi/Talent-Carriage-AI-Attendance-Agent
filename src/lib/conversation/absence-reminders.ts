import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { absenceEscalations, actions, approvals, calls, cases, employees, jobs, managers, messages } from '@/db/schema';
import { managerFor, OUTCOME_TEMPLATE, tellManager, type ManagerRow } from '@/lib/approvals';
import type { Outbound } from '@/lib/channels/types';
import type { FullContext } from '@/lib/runtime';
import { addWorkingDays, isWorkingDay, morningOf, today } from '@/lib/dates';
import { handToHr, stepDay, tellEmployee } from '@/lib/hr';
import { requestCases } from '@/lib/approval-dates';
import { placeApprovalCall } from '@/lib/voice/approval-calls';
import {
  ABSENT_ESCALATED_TEMPLATE,
  ABSENT_ESCALATED_TEMPLATE_BODY,
  MANAGER_NO_RESPONSE_BUTTONS,
  MANAGER_NO_RESPONSE_TEMPLATE,
  MANAGER_NO_RESPONSE_TEMPLATE_BODY,
} from './absence-templates';
import { datesLabel } from './absence-group';
import { canSend, deliver, getConversation, sendPlainText, windowOpen, type CaseRow, type EmployeeRow } from './engine';
import { fillTemplate, firstName, formatDate } from './flow';

/**
 * After a date's reminders run out: the manager, and what follows - the
 * WhatsApp, a call if it is ignored, then HR (`runManagerSteps`). Reminders
 * themselves, and when a date runs out of them, are in `daily-contact.ts`.
 */

const DAY_MS = 86_400_000;

export type EscalationChoice = 'speak' | 'lop';

export const escalationSelectionId = (escalationId: string, choice: EscalationChoice) => `esc:${escalationId}:${choice}`;

export function parseEscalationSelectionId(value: string | undefined | null): { escalationId: string; choice: EscalationChoice } | null {
  const match = /^esc:([0-9a-f-]{36}):(speak|lop)$/i.exec(value ?? '');
  return match ? { escalationId: match[1]!, choice: match[2]!.toLowerCase() as EscalationChoice } : null;
}

/** "your manager, Deepak", "your manager", or "HR" when the file names nobody. */
const transfereeOf = (manager: ManagerRow | null, route: string) =>
  manager && route !== 'hr' ? (manager.fullName && manager.fullName !== 'Manager' ? `your manager, ${firstName(manager.fullName)}` : 'your manager') : 'HR';

/**
 * Hands unanswered dates to the manager: the employee is warned, the dates
 * become Escalated, and the manager is asked to speak to them or mark the days
 * as Loss of Pay. With no manager in the file, HR has them.
 */
export async function escalateAbsences(ctx: FullContext, employee: EmployeeRow, rows: CaseRow[], reason: string, at = new Date()) {
  const manager = await managerFor(ctx.tx, ctx.tenantId, employee);
  const dates = datesLabel(rows);
  const transferee = transfereeOf(manager, ctx.settings.escalationRoute);
  const ids = rows.map((row) => row.id);

  // Told once, on WhatsApp: the last reminder already warned them this would happen.
  if (!canSend(ctx, employee).blocked) {
    const variables = [firstName(employee.fullName), dates, transferee];
    const body = fillTemplate(ABSENT_ESCALATED_TEMPLATE_BODY, variables);
    if (windowOpen(await getConversation(ctx, employee.id), at)) await sendPlainText(ctx, employee, body, rows[0]!.id);
    else
      await deliver(
        ctx,
        employee,
        { kind: 'template', to: employee.mobileE164!, templateName: ABSENT_ESCALATED_TEMPLATE, language: 'en', variables, preview: body },
        { caseId: rows[0]!.id, kind: 'template', body, templateName: ABSENT_ESCALATED_TEMPLATE },
      );
  }

  // Straight to HR when set so, or when the file names no manager. The warning above already said so.
  if (!manager || ctx.settings.escalationRoute === 'hr') {
    await handToHr(ctx, employee, rows, manager ? reason : `${reason}, and the file names no manager`, at, true);
    return { escalated: 'hr', dates: rows.length };
  }

  // The manager's first step is this WhatsApp; the call comes if it goes unanswered.
  const [escalation] = await ctx.tx
    .insert(absenceEscalations)
    .values({
      tenantId: ctx.tenantId,
      employeeId: employee.id,
      managerId: manager.id,
      caseIds: ids,
      reason,
      steps: 0,
      nextStepAt: morningOf(stepDay(ctx.settings, at, ctx.settings.managerRespondDays), ctx.settings.timezone),
    })
    .returning();
  await ctx.tx
    .update(cases)
    .set({ status: 'escalated', needsHrReason: `${reason}; passed to ${manager.fullName}`, followUpDueAt: null, updatedAt: at })
    .where(inArray(cases.id, ids));
  await sendEscalation(ctx, escalation!.id, manager, employee, dates, at);
  return { escalated: 'manager', dates: rows.length };
}

/**
 * The manager's message, with its two buttons: as plain buttons while they have
 * written in the last day, else as the approved template.
 */
async function sendEscalation(ctx: FullContext, escalationId: string, manager: ManagerRow, employee: EmployeeRow, dates: string, at: Date) {
  const who = `${employee.fullName} (${employee.empCode})`;
  const body = fillTemplate(MANAGER_NO_RESPONSE_TEMPLATE_BODY, [who, dates]);
  const ids = [escalationSelectionId(escalationId, 'speak'), escalationSelectionId(escalationId, 'lop')];
  const [recent] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.tenantId, ctx.tenantId), eq(messages.waId, manager.mobileE164), eq(messages.direction, 'inbound'), gte(messages.createdAt, new Date(at.getTime() - DAY_MS))))
    .limit(1);
  const message: Outbound = recent
    ? {
        kind: 'buttons',
        to: manager.mobileE164,
        body,
        buttons: [
          { id: ids[0]!, title: MANAGER_NO_RESPONSE_BUTTONS.speak },
          { id: ids[1]!, title: MANAGER_NO_RESPONSE_BUTTONS.lossOfPay },
        ],
      }
    : {
        kind: 'template',
        to: manager.mobileE164,
        templateName: MANAGER_NO_RESPONSE_TEMPLATE,
        language: 'en',
        variables: [who, dates],
        buttonPayloads: ids,
        preview: body,
      };
  let providerMessageId: string | null = null;
  let status: 'sent' | 'simulated' | 'failed' = 'sent';
  let error: string | null = null;
  try {
    const result = await ctx.channel.send(message);
    providerMessageId = result.providerMessageId;
    if (result.simulated) status = 'simulated';
  } catch (problem) {
    status = 'failed';
    error = (problem as Error).message.slice(0, 500);
  }
  // Kept with no case, so it never shows in the employee's own chat.
  await ctx.tx.insert(messages).values({
    tenantId: ctx.tenantId,
    direction: 'outbound',
    channel: 'whatsapp',
    kind: message.kind === 'template' ? 'template' : 'interactive',
    status,
    providerMessageId,
    waId: manager.mobileE164,
    templateName: message.kind === 'template' ? MANAGER_NO_RESPONSE_TEMPLATE : null,
    body,
    payload: { aboutEscalationId: escalationId },
    error,
    sentAt: error ? null : at,
  });
  if (!error) await ctx.tx.update(absenceEscalations).set({ sentAt: at }).where(eq(absenceEscalations.id, escalationId));
}

/**
 * The manager tapped a button. Only the manager it went to decides, and once:
 * "I'll speak to them" leaves the dates Escalated with that noted for HR; "Mark
 * as Loss of Pay" closes them as absent without pay and tells the employee.
 */
export async function decideEscalation(
  ctx: FullContext,
  escalationId: string,
  choice: EscalationChoice,
  fromMobile: string,
  at = new Date(),
  via: 'whatsapp' | 'call' = 'whatsapp',
) {
  const escalation = await ctx.tx.query.absenceEscalations.findFirst({
    where: and(eq(absenceEscalations.id, escalationId), eq(absenceEscalations.tenantId, ctx.tenantId)),
  });
  if (!escalation?.managerId) return { handled: false, reason: 'unknown_escalation' };
  const manager = await ctx.tx.query.managers.findFirst({ where: eq(managers.id, escalation.managerId) });
  if (!manager || manager.mobileE164 !== fromMobile) return { handled: false, reason: 'not_the_manager' };
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, escalation.employeeId) });
  if (!employee) return { handled: false, reason: 'missing_employee' };

  const rows = escalation.caseIds.length
    ? await ctx.tx.select().from(cases).where(and(inArray(cases.id, escalation.caseIds), eq(cases.status, 'escalated'))).orderBy(cases.attDate)
    : [];
  if (escalation.decision || !rows.length) {
    if (via === 'whatsapp') await tellManager(ctx, manager, `This was already dealt with for ${employee.fullName}.`, undefined, true);
    return { handled: true, reason: 'already_decided' };
  }
  const dates = datesLabel(rows);
  const ids = rows.map((row) => row.id);
  // "I'll speak to them" gives the employee a few working days; then HR, if the file still shows it.
  const speakUntil = choice === 'speak' ? addWorkingDays(today(ctx.settings.timezone, at), Math.max(0, ctx.settings.speakGraceDays), ctx.settings) : null;
  await ctx.tx
    .update(absenceEscalations)
    .set({
      decision: choice === 'lop' ? 'loss_of_pay' : 'speak',
      decidedAt: at,
      speakUntil,
      nextStepAt: speakUntil ? morningOf(addWorkingDays(speakUntil, 1, ctx.settings), ctx.settings.timezone) : null,
    })
    .where(eq(absenceEscalations.id, escalation.id));

  if (choice === 'speak') {
    await ctx.tx
      .update(cases)
      .set({ needsHrReason: `${manager.fullName} will speak to them`, updatedAt: at })
      .where(inArray(cases.id, ids));
    await tellEmployee(
      ctx,
      employee,
      rows[0]!,
      dates,
      `Your manager, ${firstName(manager.fullName)}, will speak to you about it. Please apply what is needed in the HRMS by ${formatDate(speakUntil!)}.`,
      at,
    );
    if (via === 'whatsapp') await tellManager(ctx, manager, `Noted - thank you. HR can see you will speak to ${employee.fullName} about ${dates}.`, ids[0], true);
    return { handled: true };
  }

  await ctx.tx
    .update(cases)
    .set({ status: 'resolved', resolvedAt: at, closeReason: `Marked Loss of Pay by ${manager.fullName} after no reply`, updatedAt: at })
    .where(inArray(cases.id, ids));
  await tellEmployeeLossOfPay(ctx, employee, rows[0]!, dates, firstName(manager.fullName), at);
  if (via === 'whatsapp') await tellManager(ctx, manager, `Noted - ${dates} marked as Loss of Pay, and ${employee.fullName} has been told on WhatsApp.`, ids[0], true);
  return { handled: true };
}

/** The manager's WhatsApp again, as it was: after a call they did not decide on. */
export async function resendEscalation(ctx: FullContext, escalationId: string, at = new Date()) {
  const escalation = await ctx.tx.query.absenceEscalations.findFirst({ where: eq(absenceEscalations.id, escalationId) });
  if (!escalation?.managerId || escalation.decision) return;
  const manager = await ctx.tx.query.managers.findFirst({ where: eq(managers.id, escalation.managerId) });
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, escalation.employeeId) });
  const rows = escalation.caseIds.length ? await ctx.tx.select().from(cases).where(and(inArray(cases.id, escalation.caseIds), eq(cases.status, 'escalated'))).orderBy(cases.attDate) : [];
  if (!manager || !employee || !rows.length) return;
  await sendEscalation(ctx, escalation.id, manager, employee, datesLabel(rows), at);
}

/** Whether this number was already rung today: a manager is called at most once a day. */
async function rungToday(ctx: FullContext, to: string, at: Date) {
  const [row] = await ctx.tx
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.toNumber, to), sql`(coalesce(${calls.startedAt}, ${calls.endedAt}) at time zone ${ctx.settings.timezone})::date = ${today(ctx.settings.timezone, at)}`))
    .limit(1);
  return Boolean(row);
}

const nextMorning = (ctx: FullContext, at: Date) => morningOf(addWorkingDays(today(ctx.settings.timezone, at), 1, ctx.settings), ctx.settings.timezone);

/**
 * The manager's steps, for every request and escalation whose time has come:
 * a WhatsApp ignored for the set working days brings a call, whatever the
 * manager's own Contact by says; a call ignored as long brings HR (unless set
 * to the manager only). "I'll speak to them" ends at HR too, if the file still
 * shows the dates. Run hourly; a step on a non-working day waits.
 */
export async function runManagerSteps(ctx: FullContext, at = new Date()) {
  const s = ctx.settings;
  if (!isWorkingDay(today(s.timezone, at), s)) return { skipped: 'not a working day' };
  const done = { called: 0, toHr: 0 };
  const respond = () => morningOf(stepDay(s, at, s.managerRespondDays), s.timezone);

  // Requests to approve: applications, and dates still not applied after the follow-ups.
  const due = await ctx.tx
    .select({ approval: approvals, action: actions, manager: managers })
    .from(approvals)
    .innerJoin(actions, eq(actions.id, approvals.actionId))
    .innerJoin(managers, eq(managers.id, approvals.approverManagerId))
    .where(
      and(
        eq(approvals.tenantId, ctx.tenantId),
        eq(approvals.decision, 'pending'),
        isNotNull(approvals.sentAt),
        lte(approvals.timeoutAt, at),
        // A locked month's request waits with its case; unlocking gives it back the time it had left.
        sql`not exists (select 1 from cases c where c.id = ${actions.caseId} and c.status = 'unresolved')`,
      ),
    )
    .limit(100);
  for (const { approval, action, manager } of due) {
    const caseRow = action.caseId ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, action.caseId) }) : null;
    const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, action.employeeId) });
    if (!caseRow || !employee) continue;
    if (approval.nudges === 0) {
      // Manual managers get nothing automatic: the call step is skipped.
      if (manager.operatingMode !== 'manual') {
        if (await rungToday(ctx, manager.mobileE164, at)) {
          await ctx.tx.update(approvals).set({ timeoutAt: nextMorning(ctx, at) }).where(eq(approvals.id, approval.id));
          continue;
        }
        const placed = ctx.voice && ctx.baseUrl
          ? await placeApprovalCall(ctx, 'manager_approval', caseRow, employee, manager.mobileE164, (manager.callMode ?? s.callMode) === 'agent')
          : { placed: false as const, reason: 'No voice provider' };
        if (!placed.placed && 'busy' in placed && placed.busy) continue;
        if (placed.placed) {
          done.called++;
          await ctx.tx.update(approvals).set({ channel: 'voice' }).where(eq(approvals.id, approval.id));
        }
      }
      await ctx.tx.update(approvals).set({ nudges: 1, timeoutAt: respond() }).where(eq(approvals.id, approval.id));
      continue;
    }
    if (s.escalationRoute === 'manager') {
      await ctx.tx.update(approvals).set({ timeoutAt: null }).where(eq(approvals.id, approval.id));
      continue;
    }
    await ctx.tx.update(approvals).set({ decision: 'expired', escalatedTo: 'hr', respondedAt: at }).where(eq(approvals.id, approval.id));
    const covered = (await requestCases(ctx.tx, approval)).map((row) => row.caseRow);
    await handToHr(ctx, employee, covered.length ? covered : [caseRow], `${manager.fullName} did not respond`, at);
    done.toHr++;
  }

  // Team members who never answered.
  const escalations = await ctx.tx
    .select({ escalation: absenceEscalations, manager: managers })
    .from(absenceEscalations)
    .innerJoin(managers, eq(managers.id, absenceEscalations.managerId))
    .where(and(eq(absenceEscalations.tenantId, ctx.tenantId), lte(absenceEscalations.nextStepAt, at)))
    .limit(100);
  for (const { escalation, manager } of escalations) {
    const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, escalation.employeeId) });
    const rows = escalation.caseIds.length
      ? await ctx.tx.select().from(cases).where(and(inArray(cases.id, escalation.caseIds), eq(cases.status, 'escalated'))).orderBy(cases.attDate)
      : [];
    const finished = () => ctx.tx.update(absenceEscalations).set({ nextStepAt: null }).where(eq(absenceEscalations.id, escalation.id));
    // Settled since - by the file, Loss of Pay, or HR - nothing more to do.
    if (!employee || !rows.length || escalation.decision === 'loss_of_pay') {
      await finished();
      continue;
    }
    if (escalation.decision === null && escalation.steps === 0) {
      if (manager.operatingMode !== 'manual') {
        if (await rungToday(ctx, manager.mobileE164, at)) {
          await ctx.tx.update(absenceEscalations).set({ nextStepAt: nextMorning(ctx, at) }).where(eq(absenceEscalations.id, escalation.id));
          continue;
        }
        const placed = ctx.voice && ctx.baseUrl
          ? await placeApprovalCall(ctx, 'manager_escalation', rows[0]!, employee, manager.mobileE164, (manager.callMode ?? s.callMode) === 'agent')
          : { placed: false as const, reason: 'No voice provider' };
        if (!placed.placed && 'busy' in placed && placed.busy) continue;
        if (placed.placed) done.called++;
      }
      await ctx.tx.update(absenceEscalations).set({ steps: 1, nextStepAt: respond() }).where(eq(absenceEscalations.id, escalation.id));
      continue;
    }
    // The call went unanswered, or "I'll speak to them" ran out with the file still showing it.
    await finished();
    if (s.escalationRoute === 'manager') continue;
    const why = escalation.decision === 'speak' ? `${manager.fullName} was to speak to them, and it is still not sorted` : `${manager.fullName} did not respond`;
    await handToHr(ctx, employee, rows, why, at);
    done.toHr++;
  }
  return done;
}

/** The employee is told on WhatsApp, as any manager decision is: plain inside the window, the approved update template outside it. */
async function tellEmployeeLossOfPay(ctx: FullContext, employee: EmployeeRow, lead: CaseRow, dates: string, manager: string, at: Date) {
  if (canSend(ctx, employee).blocked) return;
  const decided = `${manager} has marked it as Loss of Pay, as we did not hear from you.`;
  if (windowOpen(await getConversation(ctx, employee.id), at)) {
    const body = `Hi ${firstName(employee.fullName)}, your manager, ${manager}, has marked your absence on ${dates} as Loss of Pay, as we did not hear from you.`;
    await sendPlainText(ctx, employee, body, lead.id);
    return;
  }
  const variables = [firstName(employee.fullName), 'absence', dates, decided];
  const preview = `Hi ${variables[0]}, an update on your absence for ${dates}: ${decided}\n\nReply here if you have any questions.`;
  await deliver(
    ctx,
    employee,
    { kind: 'template', to: employee.mobileE164!, templateName: OUTCOME_TEMPLATE, language: 'en', variables, preview },
    { caseId: lead.id, kind: 'template', body: preview, templateName: OUTCOME_TEMPLATE },
  );
}
