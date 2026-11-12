import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { absenceEscalations, calls, cases, employees, jobs, managers, messages } from '@/db/schema';
import { channelFor } from '@/lib/channel';
import { managerFor, OUTCOME_TEMPLATE, tellManager, type ManagerRow } from '@/lib/approvals';
import { enqueue } from '@/lib/jobs/queue';
import type { Outbound } from '@/lib/channels/types';
import type { FullContext } from '@/lib/runtime';
import { placeCaseCall } from '@/lib/voice/session';
import { today } from '@/lib/dates';
import {
  ABSENT_ESCALATED_TEMPLATE,
  ABSENT_ESCALATED_TEMPLATE_BODY,
  MANAGER_NO_RESPONSE_BUTTONS,
  MANAGER_NO_RESPONSE_TEMPLATE,
  MANAGER_NO_RESPONSE_TEMPLATE_BODY,
} from './absence-templates';
import { askGroup, datesLabel, nextAbsenceCheck, noteAbsenceContact, scheduleAbsenceWatch, unansweredCases } from './absence-group';
import { canSend, deliver, getConversation, sendPlainText, windowOpen, type CaseRow, type EmployeeRow } from './engine';
import { fillTemplate, firstName } from './flow';

/**
 * When a first message or call about absences goes unanswered.
 *
 * Nothing else would ever chase it, so each person has a check booked for when
 * it is next due (`scheduleAbsenceWatch`): a reminder every N days after the
 * last message or call - a new absence message counts as one and moves the
 * clock on, without counting as a reminder - and, after so many reminders or so
 * many days since the oldest date was first asked, whichever comes first, the
 * manager. The employee is warned first, the way the last follow-up warns.
 *
 * This runs on the clock, not with uploads: the customer asked for reminders to
 * go N days on whether or not a file arrives.
 */

const DAY_MS = 86_400_000;

/** A stored call style, as a call wants it. */
const callStyle = (value: string | null | undefined): 'keypad' | 'agent' => (value === 'agent' ? 'agent' : 'keypad');

export type EscalationChoice = 'speak' | 'lop';

export const escalationSelectionId = (escalationId: string, choice: EscalationChoice) => `esc:${escalationId}:${choice}`;

export function parseEscalationSelectionId(value: string | undefined | null): { escalationId: string; choice: EscalationChoice } | null {
  const match = /^esc:([0-9a-f-]{36}):(speak|lop)$/i.exec(value ?? '');
  return match ? { escalationId: match[1]!, choice: match[2]!.toLowerCase() as EscalationChoice } : null;
}

/** Whether this person is reached without HR pressing anything. Manual people get a "Reminder due" mark instead. */
const automatic = (employee: EmployeeRow, ctx: FullContext) => (employee.operatingMode ?? ctx.settings.operatingMode) === 'automatic';

/** Whether a reminder is due for this person, for the dashboard's mark. */
export function reminderDue(employee: Pick<EmployeeRow, 'absenceContactAt'>, settings: FullContext['settings'], at = new Date()): boolean {
  if (settings.reminderIntervalDays <= 0 || !employee.absenceContactAt) return false;
  return employee.absenceContactAt.getTime() + settings.reminderIntervalDays * DAY_MS <= at.getTime();
}

/** Whether a call already went to this person today. Two in a day is one too many. */
async function calledToday(ctx: FullContext, employeeId: string, at: Date) {
  const day = today(ctx.settings.timezone, at);
  const [row] = await ctx.tx
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.employeeId, employeeId), sql`(coalesce(${calls.startedAt}, ${calls.endedAt}) at time zone ${ctx.settings.timezone})::date = ${day}`))
    .limit(1);
  return Boolean(row);
}

/** Whether an upload's send is still to reach this person today - it will carry these dates too. */
async function sendLaterToday(ctx: FullContext, employeeId: string, at: Date) {
  const [row] = await ctx.tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, 'upload_contact'),
        eq(jobs.status, 'pending'),
        sql`${jobs.payload}->>'employeeId' = ${employeeId}`,
        gte(jobs.runAt, at),
        sql`(${jobs.runAt} at time zone ${ctx.settings.timezone})::date = ${today(ctx.settings.timezone, at)}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Books the same check for later, when something stood in its way now. */
async function moveTo(ctx: FullContext, employeeId: string, when: Date) {
  await enqueue('absence_watch', { employeeId }, { tenantId: ctx.tenantId, runAt: when, dedupeKey: `absence_watch:${employeeId}:${when.toISOString()}`, priority: 4 }, ctx.tx);
  return when;
}

/**
 * One person's booked check. Everything is looked at afresh: they may have
 * answered, been contacted since, been set to Manual, or the settings changed.
 */
export async function runAbsenceWatch(ctx: FullContext, employeeId: string, at = new Date()) {
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, employeeId) });
  if (!employee || employee.deletedAt) return { skipped: 'employee is gone' };
  const waiting = await unansweredCases(ctx, employeeId, { askedOnly: true });
  if (!waiting.length) return { skipped: 'nothing unanswered' };

  const due = await nextAbsenceCheck(ctx, employeeId, at);
  if (!due) return { skipped: 'reminders and escalation are off' };
  // Contacted since this was booked: a later check has been booked for that.
  if (due.getTime() > at.getTime() + 60_000) return { skipped: 'not due yet', next: await scheduleAbsenceWatch(ctx, employeeId, at) };
  if (!automatic(employee, ctx)) return { skipped: 'manual: HR sends reminders from the dashboard' };
  if (!ctx.settings.sendingEnabled) return { skipped: 'sending is off', next: await moveTo(ctx, employeeId, new Date(at.getTime() + DAY_MS)) };

  const s = ctx.settings;
  const firstAsked = Math.min(...waiting.map((row) => (row.askedAt ?? at).getTime()));
  const lastContact = (employee.absenceContactAt ?? at).getTime();
  const byDays = s.escalateAfterDays > 0 && at.getTime() + 60_000 >= firstAsked + s.escalateAfterDays * DAY_MS;
  const reminderTime = s.reminderIntervalDays > 0 && at.getTime() + 60_000 >= lastContact + s.reminderIntervalDays * DAY_MS;
  const byCount = reminderTime && s.remindersBeforeEscalation > 0 && employee.absenceReminders >= s.remindersBeforeEscalation;
  if (byDays || byCount) {
    const reason = byDays
      ? `No reply ${s.escalateAfterDays} days after first being asked`
      : `No reply after ${employee.absenceReminders} ${employee.absenceReminders === 1 ? 'reminder' : 'reminders'}`;
    return escalateAbsences(ctx, employee, waiting, reason, at);
  }
  if (!reminderTime) return { skipped: 'not due yet', next: await scheduleAbsenceWatch(ctx, employeeId, at) };

  // The reminder, the way reminders are set - their own channel winning.
  if (channelFor(employee, s.reminderChannel) === 'voice') {
    // An upload's call later today carries these dates; one already today means tomorrow.
    if (await sendLaterToday(ctx, employeeId, at)) return { skipped: 'joins the call going out later today' };
    if (await calledToday(ctx, employeeId, at)) return { moved: await moveTo(ctx, employeeId, new Date(at.getTime() + DAY_MS)) };
    const placed = await placeCaseCall(ctx, waiting[0]!, employee, 'first_contact', callStyle(employee.callMode ?? s.reminderCallMode));
    if (!placed.placed) {
      if ('busy' in placed && placed.busy) return { moved: await moveTo(ctx, employeeId, new Date(at.getTime() + 15 * 60_000)) };
      return { skipped: placed.reason };
    }
    await ctx.tx.update(employees).set({ absenceReminders: employee.absenceReminders + 1 }).where(eq(employees.id, employeeId));
    await noteAbsenceContact(ctx, employeeId, at);
    return { reminded: 'call', dates: waiting.length };
  }
  const sent = await askGroup({ ...ctx, now: () => at }, employee, waiting, 'reminder');
  if (!sent.sent) return { skipped: sent.reason };
  await ctx.tx.update(employees).set({ absenceReminders: employee.absenceReminders + 1 }).where(eq(employees.id, employeeId));
  return { reminded: 'whatsapp', dates: waiting.length };
}

/** "your manager, Deepak", "your manager", or "HR" when the file names nobody. */
const transfereeOf = (manager: ManagerRow | null) =>
  manager ? (manager.fullName && manager.fullName !== 'Manager' ? `your manager, ${firstName(manager.fullName)}` : 'your manager') : 'HR';

/**
 * Hands unanswered dates to the manager: the employee is warned, the dates
 * become Escalated, and the manager is asked to speak to them or mark the days
 * as Loss of Pay. With no manager in the file, HR has them.
 */
export async function escalateAbsences(ctx: FullContext, employee: EmployeeRow, rows: CaseRow[], reason: string, at = new Date()) {
  const manager = await managerFor(ctx.tx, ctx.tenantId, employee);
  const dates = datesLabel(rows);
  const transferee = transfereeOf(manager);
  const ids = rows.map((row) => row.id);

  // The last word to them, the way reminders go; a call that cannot be placed is written instead.
  let warned = false;
  if (channelFor(employee, ctx.settings.reminderChannel) === 'voice' && !(await calledToday(ctx, employee.id, at))) {
    const placed = await placeCaseCall(ctx, rows[0]!, employee, 'escalation_notice', callStyle(employee.callMode ?? ctx.settings.reminderCallMode));
    warned = placed.placed;
  }
  if (!warned && !canSend(ctx, employee).blocked) {
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
  await ctx.tx.update(employees).set({ absenceReminders: 0 }).where(eq(employees.id, employee.id));

  if (!manager) {
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: `${reason}, and the file names no manager`, followUpDueAt: null, updatedAt: at })
      .where(inArray(cases.id, ids));
    return { escalated: 'hr', dates: rows.length };
  }

  const [escalation] = await ctx.tx
    .insert(absenceEscalations)
    .values({ tenantId: ctx.tenantId, employeeId: employee.id, managerId: manager.id, caseIds: ids, reason })
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
export async function decideEscalation(ctx: FullContext, escalationId: string, choice: EscalationChoice, fromMobile: string, at = new Date()) {
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
    await tellManager(ctx, manager, `This was already dealt with for ${employee.fullName}.`, undefined, true);
    return { handled: true, reason: 'already_decided' };
  }
  const dates = datesLabel(rows);
  const ids = rows.map((row) => row.id);
  await ctx.tx
    .update(absenceEscalations)
    .set({ decision: choice === 'lop' ? 'loss_of_pay' : 'speak', decidedAt: at })
    .where(eq(absenceEscalations.id, escalation.id));

  if (choice === 'speak') {
    await ctx.tx
      .update(cases)
      .set({ needsHrReason: `${manager.fullName} will speak to them`, updatedAt: at })
      .where(inArray(cases.id, ids));
    await tellManager(ctx, manager, `Noted - thank you. HR can see you will speak to ${employee.fullName} about ${dates}.`, ids[0], true);
    return { handled: true };
  }

  await ctx.tx
    .update(cases)
    .set({ status: 'resolved', resolvedAt: at, closeReason: `Marked Loss of Pay by ${manager.fullName} after no reply`, updatedAt: at })
    .where(inArray(cases.id, ids));
  await tellEmployeeLossOfPay(ctx, employee, rows[0]!, dates, firstName(manager.fullName), at);
  await tellManager(ctx, manager, `Noted - ${dates} marked as Loss of Pay, and ${employee.fullName} has been told on WhatsApp.`, ids[0], true);
  return { handled: true };
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
