import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { cases, conversations, employees } from '@/db/schema';
import type { Meaning } from '@/lib/mapping/meanings';
import { lockedMonths, monthOf } from '@/lib/locks';
import { enqueue } from '@/lib/jobs/queue';
import {
  ABSENT_GROUP_TEMPLATE,
  ABSENT_GROUP_TEMPLATE_BODY,
  ABSENT_REMINDER_TEMPLATE,
  ABSENT_REMINDER_TEMPLATE_BODY,
} from './absence-templates';
import { askCase, canSend, deliver, getConversation, UNANSWERED, windowOpen, type CaseRow, type EmployeeRow, type EngineContext } from './engine';
import { randomUUID } from 'node:crypto';
import { buildOptionList, dateLabel, fillTemplate, firstName, groupSelectionId, OPTION_NUMBERS } from './flow';

/**
 * Asking about absences once per person, not once per date.
 *
 * Every date somebody has not answered goes in one message - "you are marked
 * absent on 3 Nov and 6 Nov" - with the four reasons as buttons. A button
 * answers every date the message listed; typing can answer them differently.
 *
 * The buttons name one case, the oldest date, which leads the group: the dates
 * the message listed are kept on that case (`context.group`), so whatever the
 * tap leads to - what happened, leave or Loss of Pay, applied yet - is asked
 * once and recorded on each of them.
 */

export type GroupMember = { id: string; date: string; meaning: string };

/** The dates a lead case's message listed, itself first; empty when it asked about itself alone. */
export function groupMembers(caseRow: Pick<CaseRow, 'context'>): GroupMember[] {
  const group = (caseRow.context as { group?: GroupMember[] } | null)?.group;
  return Array.isArray(group) ? group : [];
}

/** "3 Nov", "3 Nov and 6 Nov", "3 Nov, 4 Nov and 6 Nov". */
export function datesLabel(rows: { date?: string; attDate?: string; meaning: string }[]): string {
  const labels = rows.map((row) => dateLabel((row.date ?? row.attDate)!, row.meaning as Meaning));
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** How a case's date is named in the menus: the whole group's dates for a lead, else its own. */
export function caseDatesLabel(caseRow: CaseRow): string {
  const members = groupMembers(caseRow);
  return members.length > 1 ? datesLabel(members) : dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
}

/**
 * Every date this person has not answered, oldest first, up to `upTo`: the ones
 * never asked (`queued`) and the ones asked and ignored. A locked month's dates
 * are final and never asked about.
 */
export async function unansweredCases(
  ctx: EngineContext,
  employeeId: string,
  opts: { upTo?: string; askedOnly?: boolean } = {},
): Promise<CaseRow[]> {
  const statuses = opts.askedOnly ? (['asked', 'delivered', 'read'] as const) : UNANSWERED;
  const rows = await ctx.tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.tenantId, ctx.tenantId),
        eq(cases.employeeId, employeeId),
        inArray(cases.status, [...statuses]),
        opts.upTo ? lte(cases.attDate, opts.upTo) : undefined,
      ),
    )
    .orderBy(asc(cases.attDate));
  const locked = await lockedMonths(ctx.tx, ctx.tenantId);
  return rows.filter((row) => !locked.has(monthOf(row.attDate)));
}

/**
 * The cases a lead's answer settles: the lead and every date its message listed
 * that is still unanswered. A case asked about alone is just itself.
 */
export async function liveGroup(ctx: EngineContext, lead: CaseRow): Promise<CaseRow[]> {
  const others = groupMembers(lead)
    .map((member) => member.id)
    .filter((id) => id !== lead.id);
  if (!others.length) return [lead];
  const rows = await ctx.tx
    .select()
    .from(cases)
    .where(and(inArray(cases.id, others), inArray(cases.status, [...UNANSWERED])))
    .orderBy(asc(cases.attDate));
  return [lead, ...rows];
}

/** How many messages' worth of dates a lead case remembers, newest kept. */
const GROUPS_KEPT = 10;

/**
 * Sets the dates the lead's answer is for, or clears them when it is answered
 * alone. With `groupId`, also remembers them as that message's dates, so a tap
 * on that message later answers exactly what it listed.
 */
export async function setGroup(ctx: EngineContext, lead: CaseRow, rows: CaseRow[], groupId?: string): Promise<CaseRow> {
  const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, lead.id), columns: { context: true } }))?.context ?? lead.context ?? {};
  const { group: _old, ...rest } = fresh as Record<string, unknown>;
  // Kept oldest first, whichever date leads, so every message reads them in order.
  const members = [...rows].sort((a, b) => a.attDate.localeCompare(b.attDate)).map((row) => ({ id: row.id, date: row.attDate, meaning: row.meaning }));
  const context: Record<string, unknown> = rows.length > 1 ? { ...rest, group: members } : rest;
  if (groupId) {
    const groups = Object.entries((rest.groups as Record<string, GroupMember[]> | undefined) ?? {}).slice(-(GROUPS_KEPT - 1));
    context.groups = Object.fromEntries([...groups, [groupId, members]]);
  }
  await ctx.tx.update(cases).set({ context, updatedAt: new Date() }).where(eq(cases.id, lead.id));
  return { ...lead, context };
}

/**
 * A tap on a message about several dates: the dates that message listed which
 * are still open, led by the oldest of them. Empty when none is.
 */
export async function groupForTap(ctx: EngineContext, tapped: CaseRow, groupId: string): Promise<CaseRow | null> {
  const listed = ((tapped.context as { groups?: Record<string, GroupMember[]> } | null)?.groups ?? {})[groupId] ?? [];
  if (!listed.length) return null;
  const open = await ctx.tx
    .select()
    .from(cases)
    .where(and(inArray(cases.id, listed.map((member) => member.id)), inArray(cases.status, [...UNANSWERED])))
    .orderBy(asc(cases.attDate));
  if (!open.length) return null;
  return setGroup(ctx, open[0]!, open);
}

export type AskKind = 'first' | 'reminder';

/** The question in a message's own words: the template's, inside the window as well, so the two always say the same. */
function questionBody(kind: AskKind, name: string, dates: string): string {
  return fillTemplate(kind === 'reminder' ? ABSENT_REMINDER_TEMPLATE_BODY : ABSENT_GROUP_TEMPLATE_BODY, [name, dates]);
}

/**
 * Asks one person about all of `rows` in one WhatsApp message: the first
 * question, or the reminder of it. A single date asked for the first time goes
 * the way it always has (`askCase`); otherwise the oldest date leads and the
 * message lists them all. Each date counts as asked.
 */
export async function askGroup(ctx: EngineContext, employee: EmployeeRow, rows: CaseRow[], kind: AskKind) {
  if (!rows.length) return { sent: false as const, reason: 'Nothing to ask' };
  const block = canSend(ctx, employee);
  if (block.blocked) return { sent: false as const, reason: block.reason };

  const at = ctx.now?.() ?? new Date();
  const groupId = randomUUID();
  let lead = await setGroup(ctx, rows[0]!, rows, rows.length > 1 || kind === 'reminder' ? groupId : undefined);
  if (rows.length === 1 && kind === 'first') {
    const result = await askCase(ctx, lead, employee);
    if (result.sent) await noteAbsenceContact(ctx, employee.id, at);
    return result;
  }

  const name = firstName(employee.fullName);
  const dates = datesLabel(rows);
  const conversation = await getConversation(ctx, employee.id);
  const inWindow = windowOpen(conversation, at);
  const templateName = kind === 'reminder' ? ABSENT_REMINDER_TEMPLATE : ABSENT_GROUP_TEMPLATE;
  const body = questionBody(kind, name, dates);
  const message = inWindow
    ? buildOptionList({ to: employee.mobileE164!, employeeName: employee.fullName, label: dates, caseId: lead.id, remaining: rows.length, body, groupId })
    : {
        kind: 'template' as const,
        to: employee.mobileE164!,
        templateName,
        language: 'en',
        variables: [name, dates],
        buttonPayloads: OPTION_NUMBERS.map((n) => groupSelectionId(lead.id, groupId, n)),
        preview: body,
      };
  const sent = await deliver(ctx, employee, message, {
    caseId: lead.id,
    kind: inWindow ? 'interactive' : 'template',
    body,
    templateName: inWindow ? undefined : templateName,
  });

  for (const row of rows) {
    await ctx.tx
      .update(cases)
      .set({
        status: row.status === 'queued' ? 'asked' : row.status,
        askedAt: row.askedAt ?? at,
        firstMessageId: row.firstMessageId ?? sent.messageId,
        error: null,
        updatedAt: at,
      })
      .where(eq(cases.id, row.id));
  }
  lead = { ...lead, status: lead.status === 'queued' ? 'asked' : lead.status };
  await ctx.tx.update(conversations).set({ activeCaseId: lead.id, updatedAt: at }).where(eq(conversations.id, conversation.id));
  await noteAbsenceContact(ctx, employee.id, at);
  return { sent: true as const, ...sent, viaTemplate: !inWindow, leadCaseId: lead.id };
}

/**
 * A first message, call or reminder about unanswered absences went to this
 * person: the reminder clock starts again from now, and their next check is
 * booked. The count of reminders is left alone; only an answer clears it.
 */
export async function noteAbsenceContact(ctx: EngineContext, employeeId: string, at: Date) {
  await ctx.tx.update(employees).set({ absenceContactAt: at }).where(eq(employees.id, employeeId));
  await scheduleAbsenceWatch(ctx, employeeId, at);
}

const DAY_MS = 86_400_000;

/** The hour and minute it is in `timezone` at `at`, and how far that clock is from UTC. */
function localClock(at: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return { hour: Number(parts.hour), offsetMs: wall - Math.floor(at.getTime() / 60_000) * 60_000, year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** Nobody is messaged or rung at night: between 8 pm and 8 am it waits for 10 am. */
export function inWorkingHours(at: Date, timezone: string): Date {
  const clock = localClock(at, timezone);
  if (clock.hour >= 8 && clock.hour < 20) return at;
  const day = clock.hour >= 20 ? clock.day + 1 : clock.day;
  return new Date(Date.UTC(clock.year, clock.month - 1, day, 10, 0) - clock.offsetMs);
}

/**
 * When this person's unanswered absences next need something: a reminder, the
 * interval after the last contact, or the manager, so many days after the
 * oldest date was first asked - whichever comes first. Null when neither is
 * switched on or nothing is waiting.
 */
export async function nextAbsenceCheck(ctx: EngineContext, employeeId: string, at: Date): Promise<Date | null> {
  const s = ctx.settings;
  if (s.reminderIntervalDays <= 0 && s.escalateAfterDays <= 0) return null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, employeeId), columns: { absenceContactAt: true } });
  const waiting = await unansweredCases(ctx, employeeId, { askedOnly: true });
  if (!waiting.length) return null;
  const times: number[] = [];
  // Before the reminder clock existed, the last time they were asked stands in for it.
  const last = employee?.absenceContactAt ?? new Date(Math.max(...waiting.map((row) => (row.askedAt ?? at).getTime())));
  if (s.reminderIntervalDays > 0) times.push(last.getTime() + s.reminderIntervalDays * DAY_MS);
  const firstAsked = Math.min(...waiting.map((row) => (row.askedAt ?? at).getTime()));
  if (s.escalateAfterDays > 0) times.push(firstAsked + s.escalateAfterDays * DAY_MS);
  return inWorkingHours(new Date(Math.min(...times)), s.timezone);
}

/**
 * Books a check for everyone with something unanswered: when reminders or
 * escalation are switched on or changed, so it takes effect for dates already
 * waiting, not only for messages sent from now on.
 */
export async function scheduleAllAbsenceWatches(ctx: EngineContext, at = new Date()) {
  const people = await ctx.tx
    .selectDistinct({ employeeId: cases.employeeId })
    .from(cases)
    .where(and(eq(cases.tenantId, ctx.tenantId), inArray(cases.status, ['asked', 'delivered', 'read'])));
  let booked = 0;
  for (const { employeeId } of people) if (await scheduleAbsenceWatch(ctx, employeeId, at)) booked++;
  return booked;
}

/** Books this person's next check. A newer booking makes an older one find nothing to do. */
export async function scheduleAbsenceWatch(ctx: EngineContext, employeeId: string, at: Date) {
  const runAt = await nextAbsenceCheck(ctx, employeeId, at);
  if (!runAt) return null;
  await enqueue(
    'absence_watch',
    { employeeId },
    { tenantId: ctx.tenantId, runAt, dedupeKey: `absence_watch:${employeeId}:${runAt.toISOString()}`, priority: 4 },
    ctx.tx,
  );
  return runAt;
}
