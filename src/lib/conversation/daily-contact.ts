import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { cases, employees } from '@/db/schema';
import { addWorkingDays, isWorkingDay, today } from '@/lib/dates';
import { levelContact, type CallStyle } from '@/lib/level-contacts';
import { managerFor } from '@/lib/approvals';
import { channelFor } from '@/lib/channel';
import { contactDateFor } from '@/lib/detection/run';
import type { FullContext } from '@/lib/runtime';
import { placeCaseCall, type CallRow } from '@/lib/voice/session';
import { askGroup, noteAbsenceContact, unansweredCases, type AskKind, type LastWarning } from './absence-group';
import { escalateAbsences } from './absence-reminders';
import { canSend, type CaseRow, type EmployeeRow } from './engine';
import { firstName } from './flow';
import { followUpDueOnUpload, recordFollowUpSent, sendFollowUpsAfterUpload, sendFollowUpWhatsapp } from './followup';

/**
 * One decision per person per send: what is due, and whether it goes by call or
 * by WhatsApp.
 *
 * - New dates (the first question) go the way the employee is set - WhatsApp,
 *   or a call. A first-question call carries everything else due as well.
 * - Reminders, for dates asked and not answered, are counted per date: every
 *   "Remind after" working days, up to the number of reminders, after which the
 *   date goes to the manager. The first question is not a reminder.
 * - Follow-ups, for dates answered and not yet acted on.
 * - Reminders and follow-ups are a call only when the call rule allows it
 *   (`callRuleFor`): a due date's level is set to Call in Settings and the rest
 *   of the rule passes. Otherwise WhatsApp: at most one message for new and
 *   reminder dates, and one for follow-ups.
 *
 * This runs only with the send after an upload (or an unlock); a day with no
 * upload sends no reminders, as it sends no follow-ups.
 */

const day = (settings: FullContext['settings'], at: Date) => today(settings.timezone, at);

export type PersonDue = {
  /** Dates never asked: the first question. */
  fresh: CaseRow[];
  /** Dates asked and not answered whose next reminder is due. */
  reminders: CaseRow[];
  /** Dates whose reminders have all gone and whose time is up: the manager. */
  exhausted: CaseRow[];
  /** Dates answered and still to be acted on, due a follow-up. */
  followUps: CaseRow[];
};

/** Whether a date's next reminder is due today: "Remind after" working days since its last reminder, or since it was asked. */
export function reminderIsDue(row: CaseRow, settings: FullContext['settings'], at: Date): boolean {
  const interval = settings.reminderIntervalDays;
  if (interval <= 0) return false;
  const now = day(settings, at);
  const last = row.remindedAt ?? row.askedAt;
  if (!last) return false;
  const lastDay = day(settings, last);
  // Already reminded (or asked) today: one a day at most.
  if (lastDay >= now) return false;
  return now >= addWorkingDays(lastDay, interval, settings);
}

/** What is due for one person now. `fresh` and `followUps` only with an upload's send. */
export async function dueFor(
  ctx: FullContext,
  employee: EmployeeRow,
  at: Date,
  opts: { fresh: boolean; followUps: boolean },
): Promise<PersonDue> {
  const s = ctx.settings;
  const unanswered = await unansweredCases(ctx, employee.id, { upTo: contactDateFor(s, at) });
  const fresh = opts.fresh ? unanswered.filter((row) => row.status === 'queued') : [];
  const reminders: CaseRow[] = [];
  const exhausted: CaseRow[] = [];
  if (isWorkingDay(day(s, at), s)) {
    for (const row of unanswered) {
      if (row.status === 'queued' || !reminderIsDue(row, s, at)) continue;
      (row.reminderCount >= Math.max(0, s.remindersBeforeEscalation) ? exhausted : reminders).push(row);
    }
  }
  const followUps =
    opts.followUps && isWorkingDay(day(s, at), s)
      ? await ctx.tx
          .select()
          .from(cases)
          .where(and(followUpDueOnUpload(s.timezone, at), eq(cases.employeeId, employee.id)))
          .orderBy(asc(cases.attDate))
      : [];
  return { fresh, reminders, exhausted, followUps };
}

/**
 * The call rule, for reminders and follow-ups. A call only when all hold: at
 * least one date due today is at a level set to Call in Settings (its row); the
 * person ignored the last N contacts in a row; and the gap since their last
 * call has passed. One call then covers all their due dates, the ones at a
 * WhatsApp level too.
 *
 * Returns the call style - talking if any of those Call rows says so, else
 * keypad - or null for WhatsApp.
 */
export function callRuleFor(ctx: FullContext, employee: EmployeeRow, due: Pick<PersonDue, 'reminders' | 'followUps'>, at: Date): CallStyle | null {
  const s = ctx.settings;
  if (!ctx.voice || !ctx.baseUrl || employee.callOptOut || !employee.mobileE164) return null;
  const onCall = [
    ...due.reminders.map((row) => levelContact(s, 'reminder', row.reminderCount + 1)),
    ...due.followUps.map((row) => levelContact(s, 'follow_up', row.followUpCount + 1)),
  ].filter((level) => level.channel === 'voice');
  if (!onCall.length) return null;
  if (employee.ignoredContacts < s.ignoredBeforeCall) return null;
  if (employee.lastCallAt) {
    // After a call, none for the next N working days.
    const nextAllowed = addWorkingDays(day(s, employee.lastCallAt), Math.max(0, s.callGapDays) + 1, s);
    if (day(s, at) < nextAllowed) return null;
  }
  return onCall.some((level) => level.callMode === 'agent') ? 'agent' : 'keypad';
}

/** How a reminder message is worded: a date's last says what happens next; after the first, firmer. */
function reminderWording(rows: CaseRow[], settings: FullContext['settings']): 'reminder' | 'firm' | 'last' {
  const max = Math.max(1, settings.remindersBeforeEscalation);
  if (rows.some((row) => row.reminderCount + 1 >= max)) return 'last';
  if (rows.some((row) => row.reminderCount >= 1)) return 'firm';
  return 'reminder';
}

/** For a last reminder: the dates at their last, and "your manager, Deepak" or "HR". */
async function lastWarning(ctx: FullContext, employee: EmployeeRow, rows: CaseRow[]): Promise<LastWarning> {
  const max = Math.max(1, ctx.settings.remindersBeforeEscalation);
  const manager = await managerFor(ctx.tx, ctx.tenantId, employee);
  const to =
    manager && ctx.settings.escalationRoute !== 'hr'
      ? manager.fullName && manager.fullName !== 'Manager'
        ? `your manager, ${firstName(manager.fullName)}`
        : 'your manager'
      : 'HR';
  return { dates: rows.filter((row) => row.reminderCount + 1 >= max), to };
}

/**
 * Writes down a contact: reminders counted on their dates, calls on the dates a
 * call covered and on the person, and one more contact they may ignore.
 */
export async function noteContacted(
  ctx: FullContext,
  employee: EmployeeRow,
  at: Date,
  done: { reminders: CaseRow[]; called: CaseRow[]; absence: boolean },
) {
  for (const row of done.reminders) {
    await ctx.tx
      .update(cases)
      .set({ reminderCount: sql`${cases.reminderCount} + 1`, remindedAt: at, updatedAt: at })
      .where(eq(cases.id, row.id));
  }
  if (done.called.length) {
    await ctx.tx
      .update(cases)
      .set({ callsMade: sql`${cases.callsMade} + 1` })
      .where(inArray(cases.id, done.called.map((row) => row.id)));
  }
  await ctx.tx
    .update(employees)
    .set({ ignoredContacts: sql`${employees.ignoredContacts} + 1`, ...(done.called.length ? { lastCallAt: at } : {}) })
    .where(eq(employees.id, employee.id));
  if (done.absence) await noteAbsenceContact(ctx, employee.id, at);
}

/**
 * Everything due for one person, decided once: dates out of reminders go to the
 * manager; then one call, or the WhatsApps.
 */
export async function contactPerson(ctx: FullContext, employee: EmployeeRow, at: Date, opts: { fresh: boolean; followUps: boolean }) {
  const s = ctx.settings;
  const due = await dueFor(ctx, employee, at, opts);
  if (due.exhausted.length) {
    const n = Math.max(0, s.remindersBeforeEscalation);
    await escalateAbsences(ctx, employee, due.exhausted, `No reply after ${n} ${n === 1 ? 'reminder' : 'reminders'}`, at);
  }
  const { fresh, reminders, followUps } = due;
  if (!fresh.length && !reminders.length && !followUps.length) return { sent: 'nothing due' };
  if (!s.sendingEnabled || canSend(ctx, employee).blocked) return { sent: 'nothing', reason: 'sending is not allowed' };
  const timed = { ...ctx, now: () => at };

  // The first question by call, as the employee is set: one call for all of it.
  if (fresh.length && channelFor(employee, s.defaultChannel) === 'voice') {
    const placed = await placeCaseCall(ctx, fresh[0]!, employee, 'first_contact', undefined, { thenFollowUps: followUps.map((row) => row.id) });
    if (placed.placed) {
      for (const row of followUps) await recordFollowUpSent(ctx, row, employee, at);
      await noteContacted(ctx, employee, at, { reminders, called: [...fresh, ...reminders, ...followUps], absence: true });
      return { sent: 'call', dates: fresh.length + reminders.length + followUps.length };
    }
    // A call that could not be placed: the WhatsApps instead, so nothing waits a day.
  }

  const call = callRuleFor(ctx, employee, due, at);
  const messages: string[] = [];

  // WhatsApp 1: new dates, and the reminder dates unless they go on the call.
  const written = call ? fresh : [...fresh, ...reminders];
  if (written.length) {
    const writtenReminders = call ? [] : reminders;
    const wording: AskKind = writtenReminders.length ? reminderWording(writtenReminders, s) : 'first';
    const kind: AskKind = wording === 'last' ? 'last' : fresh.length ? 'first' : wording;
    const result = await askGroup(timed, employee, written, kind, kind === 'last' ? await lastWarning(ctx, employee, writtenReminders) : undefined);
    if (result.sent) messages.push('absence');
  }

  // The call: reminders first, then follow-ups - or the follow-ups alone.
  if (call) {
    if (reminders.length) {
      const placed = await placeCaseCall(ctx, reminders[0]!, employee, 'first_contact', call, {
        thenFollowUps: followUps.map((row) => row.id),
      });
      if (placed.placed) {
        for (const row of followUps) await recordFollowUpSent(ctx, row, employee, at, undefined, 'call');
        await noteContacted(ctx, employee, at, { reminders, called: [...reminders, ...followUps], absence: true });
        return { sent: messages.length ? 'whatsapp and call' : 'call', dates: written.length + reminders.length + followUps.length };
      }
      // Not placed: the reminders go on WhatsApp instead.
      const result = await askGroup(timed, employee, reminders, reminderWording(reminders, s), await lastWarning(ctx, employee, reminders));
      if (result.sent) messages.push('reminders');
    } else {
      const result = await sendFollowUpsAfterUpload(ctx, employee.id, at, true, false, 'call', call);
      if (result.called) {
        await noteContacted(ctx, employee, at, { reminders: [], called: followUps, absence: false });
        return { sent: messages.length ? 'whatsapp and call' : 'call', dates: written.length + followUps.length };
      }
    }
  }

  // WhatsApp 2: the follow-ups.
  if (followUps.length) {
    await sendFollowUpsAfterUpload(ctx, employee.id, at, true, false, 'whatsapp');
    messages.push('follow-ups');
  }
  const remindersSent = call ? (messages.includes('reminders') ? reminders : []) : reminders;
  await noteContacted(ctx, employee, at, { reminders: remindersSent, called: [], absence: written.length > 0 || remindersSent.length > 0 });
  return { sent: messages.length ? 'whatsapp' : 'nothing', messages };
}

/**
 * A call about dates that rang out: that day's WhatsApps go at once instead, so
 * nothing waits a day. It already counted as an ignored contact.
 */
export async function afterMissedCall(ctx: FullContext, call: CallRow) {
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, call.employeeId) });
  if (!employee || canSend(ctx, employee).blocked) return;
  const at = new Date();
  if (call.purpose === 'first_contact') {
    const rows = await unansweredCases(ctx, employee.id);
    if (rows.length) {
      const wording: AskKind = rows.some((row) => row.status === 'queued' || row.reminderCount === 0) ? 'first' : reminderWording(rows, ctx.settings);
      await askGroup({ ...ctx, now: () => at }, employee, rows, wording, wording === 'last' ? await lastWarning(ctx, employee, rows) : undefined);
    }
  }
  // The follow-ups the call carried, or was about.
  const since = call.startedAt ?? new Date(at.getTime() - 3_600_000);
  const followUps = await ctx.tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.employeeId, employee.id),
        eq(cases.status, 'answered'),
        isNull(cases.followUpReply),
        gte(cases.followUpSentAt, new Date(since.getTime() - 60_000)),
        call.purpose === 'follow_up' || !call.thenFollowUps?.length ? undefined : inArray(cases.id, call.thenFollowUps),
      ),
    )
    .orderBy(asc(cases.attDate));
  if ((call.purpose === 'follow_up' || call.thenFollowUps?.length) && followUps.length) await sendFollowUpWhatsapp(ctx, employee, followUps, at);
}
