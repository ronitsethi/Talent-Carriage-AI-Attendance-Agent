import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { cases, messages } from '@/db/schema';
import { addWorkingDays, isWorkingDay, today } from '@/lib/dates';
import type { Outbound } from '@/lib/channels/types';
import { OUTCOME_TEMPLATE } from '@/lib/approvals';
import { datesLabel } from '@/lib/conversation/absence-group';
import { canSend, deliver, getConversation, sendPlainText, windowOpen, type CaseRow, type EmployeeRow, type EngineContext } from '@/lib/conversation/engine';
import { fillTemplate, firstName } from '@/lib/conversation/flow';

/**
 * HR: the last step for a date nobody else settled.
 *
 * The employee is told once ("this has gone to HR, who will contact you") and
 * the agent stops messaging them about it. The dates wait on the Needs HR tab,
 * and the customer's HR contact - when one is set in Settings - is told on
 * WhatsApp as they arrive and in a daily summary. A customer with no HR contact
 * yet has the tab alone; setting one is all it takes to switch the rest on.
 */

/** The WhatsApp template HR is told by, outside their 24-hour window. {{1}} first name, {{2}} what happened. */
export const HR_ALERT_TEMPLATE = 'hr_attendance_alert';
export const HR_ALERT_TEMPLATE_BODY =
  'Hello {{1}}, this is the attendance assistant.\n\n{{2}}\n\nPlease open the Needs HR tab in the attendance portal to deal with it.';

/**
 * Hands dates to HR: Needs HR with the reason, the employee told once, and HR
 * told on WhatsApp if they have a number and want it.
 */
export async function handToHr(ctx: EngineContext, employee: EmployeeRow, rows: CaseRow[], reason: string, at = new Date(), alreadyTold = false) {
  if (!rows.length) return;
  const ids = rows.map((row) => row.id);
  await ctx.tx
    .update(cases)
    .set({ status: 'needs_hr', needsHrReason: reason.slice(0, 300), hrAt: at, followUpDueAt: null, updatedAt: at })
    .where(inArray(cases.id, ids));
  const dates = datesLabel(rows);
  if (!alreadyTold) await tellEmployee(ctx, employee, rows[0]!, dates, 'It has now gone to HR, who will contact you.', at);
  if (ctx.settings.hrTellWhatsapp) {
    await tellHr(ctx, `${employee.fullName} (${employee.empCode}): ${dates}. ${reason}.`, at);
  }
}

/** A word to the employee about these dates, on WhatsApp: plain inside the window, the update template outside it. */
export async function tellEmployee(ctx: EngineContext, employee: EmployeeRow, lead: CaseRow, dates: string, sentence: string, at = new Date()) {
  if (canSend(ctx, employee).blocked) return;
  if (windowOpen(await getConversation(ctx, employee.id), at)) {
    await sendPlainText(ctx, employee, `Hi ${firstName(employee.fullName)}, about your attendance on ${dates}: ${sentence}`, lead.id);
    return;
  }
  const variables = [firstName(employee.fullName), 'attendance', dates, sentence];
  const preview = `Hi ${variables[0]}, an update on your attendance for ${dates}: ${sentence}\n\nReply here if you have any questions.`;
  await deliver(
    ctx,
    employee,
    { kind: 'template', to: employee.mobileE164!, templateName: OUTCOME_TEMPLATE, language: 'en', variables, preview },
    { caseId: lead.id, kind: 'template', body: preview, templateName: OUTCOME_TEMPLATE },
  );
}

/**
 * A message to the customer's HR contact. Nothing at all when none is set:
 * the Needs HR tab is where they look until then.
 */
export async function tellHr(ctx: EngineContext, text: string, at = new Date()): Promise<boolean> {
  const to = ctx.settings.hrMobileE164;
  if (!to || !ctx.settings.sendingEnabled) return false;
  const name = ctx.settings.hrName ? firstName(ctx.settings.hrName) : 'there';
  const body = fillTemplate(HR_ALERT_TEMPLATE_BODY, [name, text]);
  const [recent] = await ctx.tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.tenantId, ctx.tenantId), eq(messages.waId, to), eq(messages.direction, 'inbound'), gte(messages.createdAt, new Date(at.getTime() - 86_400_000))))
    .limit(1);
  const message: Outbound = recent
    ? { kind: 'text', to, body }
    : { kind: 'template', to, templateName: HR_ALERT_TEMPLATE, language: 'en', variables: [name, text.replace(/\s+/g, ' ').slice(0, 900)], preview: body };
  let status: 'sent' | 'simulated' | 'failed' = 'sent';
  let providerMessageId: string | null = null;
  let error: string | null = null;
  try {
    const result = await ctx.channel.send(message);
    providerMessageId = result.providerMessageId;
    if (result.simulated) status = 'simulated';
  } catch (problem) {
    status = 'failed';
    error = (problem as Error).message.slice(0, 500);
  }
  // Kept with no case, so it never shows in an employee's chat.
  await ctx.tx.insert(messages).values({
    tenantId: ctx.tenantId,
    direction: 'outbound',
    channel: 'whatsapp',
    kind: message.kind === 'template' ? 'template' : 'text',
    status,
    providerMessageId,
    waId: to,
    templateName: message.kind === 'template' ? HR_ALERT_TEMPLATE : null,
    body,
    payload: { toHr: true },
    error,
    sentAt: error ? null : at,
  });
  return !error;
}

/**
 * The payroll cut-off this month, or next month once this month's has passed,
 * and whether today is within 2 working days of it. Null when it is off.
 */
export function payrollCutoff(settings: EngineContext['settings'], day: string): { cutoff: string; urgent: boolean } | null {
  const cutoffDay = settings.payrollCutoffDay;
  if (!cutoffDay || cutoffDay < 1 || cutoffDay > 31) return null;
  const [year, month] = day.split('-').map(Number) as [number, number];
  const on = (y: number, m: number) => {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(cutoffDay, last)).padStart(2, '0')}`;
  };
  let cutoff = on(year, month);
  if (cutoff < day) cutoff = month === 12 ? on(year + 1, 1) : on(year, month + 1);
  // Urgent from the second working day before the cut-off.
  let from = cutoff;
  for (let back = 0; back < 2; ) {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    from = d.toISOString().slice(0, 10);
    if (isWorkingDay(from, settings)) back++;
  }
  return { cutoff, urgent: day >= from };
}

/**
 * The daily word to HR: how many dates are waiting on them, and how many of
 * those are urgent for payroll. Working days only, and only with something to say.
 */
export async function sendHrSummary(ctx: EngineContext, at = new Date()) {
  const s = ctx.settings;
  const day = today(s.timezone, at);
  if (!s.hrMobileE164 || !s.hrDailySummary || !isWorkingDay(day, s)) return { skipped: 'no HR contact, summary off, or not a working day' };
  const [row] = await ctx.tx
    .select({ waiting: sql<number>`count(*)::int`, people: sql<number>`count(distinct ${cases.employeeId})::int` })
    .from(cases)
    .where(and(eq(cases.tenantId, ctx.tenantId), eq(cases.status, 'needs_hr')));
  if (!row?.waiting) return { skipped: 'nothing waiting' };
  const cutoff = payrollCutoff(s, day);
  const urgent = cutoff?.urgent ? ` Payroll is cut off on ${cutoff.cutoff}, so these are urgent.` : '';
  const sent = await tellHr(ctx, `${row.waiting} attendance ${row.waiting === 1 ? 'date is' : 'dates are'} waiting on you, for ${row.people} ${row.people === 1 ? 'person' : 'people'}.${urgent}`, at);
  return { sent, waiting: row.waiting };
}

/** The working day after `n` working days from today: when a step that waits `n` days falls due. */
export const stepDay = (settings: EngineContext['settings'], at: Date, n: number) => addWorkingDays(today(settings.timezone, at), Math.max(1, n), settings);
