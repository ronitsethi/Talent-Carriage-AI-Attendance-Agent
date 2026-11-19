import { and, asc, eq, inArray, isNotNull, lte, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { waitForLine } from '@/lib/voice/waiting';
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
import { callRuleFor, noteContacted } from './daily-contact';
import type { CallStyle } from '@/lib/level-contacts';
import type { FullContext } from '@/lib/runtime';
import { managerFor, requestManagerApproval } from '@/lib/approvals';
import { recordFollowUpChoice } from './follow-up-state';
import { placeCaseCall, type VoiceContext } from '@/lib/voice/session';
import { isWorkingDay, today } from '@/lib/dates';
import { datesLabel } from './absence-group';
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
  followUpGroupSelectionId,
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
async function sendReminder(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, at: Date): Promise<void> {
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
  const toHr = !manager || ctx.settings.escalationRoute === 'hr';
  return { what: OUTCOMES[chasedOutcome(caseRow)].application!.what, transferee: toHr ? 'HR' : named };
}

/**
 * The final notice on WhatsApp, for one date or all of a person's dates that
 * reached it together. Nothing to answer: only doing it, or the manager, ends it.
 */
export async function sendFinalNotice(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, at = new Date(), also: CaseRow[] = []) {
  const { what: first, transferee } = await finalNoticeFacts(ctx, caseRow, employee);
  const rows = [caseRow, ...also];
  const what = [...new Set([first, ...also.map((row) => OUTCOMES[chasedOutcome(row)].application!.what)])].join(' and ');
  const date = rows.length > 1 ? datesLabel(rows) : dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
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
export async function recordFollowUpSent(
  ctx: FollowUpContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  at: Date,
  overdue?: CaseRow[],
  via: 'whatsapp' | 'call' = 'whatsapp',
) {
  const { number, final } = nextFollowUp(caseRow, ctx.settings);
  const channel = via === 'call' ? 'voice' : 'whatsapp';
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
  // Gathered, so the manager gets one request for every date that ran out together.
  if (overdue) {
    overdue.push(caseRow);
    return;
  }

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
 * The manager's request for dates whose follow-ups ran out together: one per
 * thing still not applied (leave, regularisation...), listing all its dates.
 */
async function requestOverdue(ctx: FollowUpContext, employee: EmployeeRow, rows: CaseRow[], via: 'whatsapp' | 'call') {
  const byThing = new Map<string, CaseRow[]>();
  for (const row of rows) {
    const key = `${chasedOutcome(row)}:${notedOutcome(row)?.leaveChoice ?? ''}`;
    byThing.set(key, [...(byThing.get(key) ?? []), row]);
  }
  for (const group of byThing.values()) {
    const [lead, ...alsoCases] = [...group].sort((a, b) => a.attDate.localeCompare(b.attDate));
    const outcome = notedOutcome(lead!);
    await requestManagerApproval(ctx, lead!, employee, {
      code: chasedOutcome(lead!),
      choice: outcome?.leaveChoice ?? null,
      stage: 'overdue',
      note: outcome?.note ?? null,
      via,
      followUps: lead!.followUpCount + 1,
      alsoCases,
    });
  }
}

/** What a follow-up asks them to have done, in a few words: "apply leave for 3 Nov and 5 Nov". */
function stillToDo(rows: CaseRow[]): string {
  const byWhat = new Map<string, CaseRow[]>();
  for (const row of rows) {
    const what = OUTCOMES[chasedOutcome(row)].application!.what;
    byWhat.set(what, [...(byWhat.get(what) ?? []), row]);
  }
  return [...byWhat.entries()].map(([what, dated]) => `apply ${what} for ${datesLabel(dated)}`).join('; and ');
}

/**
 * One WhatsApp follow-up for several dates: what is still to be applied for
 * each, and one set of buttons - Done, Not done, Need help - answering them all.
 */
async function sendReminderGroup(ctx: EngineContext, employee: EmployeeRow, rows: CaseRow[], at: Date) {
  const [lead] = rows;
  const groupId = randomUUID();
  // The dates this message asked about, kept on the first, so a tap answers exactly those.
  const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, lead!.id), columns: { context: true } }))?.context ?? {};
  const kept = Object.entries(((fresh as { followGroups?: Record<string, string[]> }).followGroups) ?? {}).slice(-9);
  await ctx.tx
    .update(cases)
    .set({ context: { ...fresh, followGroups: Object.fromEntries([...kept, [groupId, rows.map((row) => row.id)]]) } })
    .where(eq(cases.id, lead!.id));

  const body = `Reminder: you still need to ${stillToDo(rows)}. Have you done it?`;
  const ids: FollowUpChoice[] = ['done', 'not_done', 'help'];
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
        buttonPayloads: ids.map((choice) => followUpGroupSelectionId(lead!.id, groupId, choice)),
        preview,
      },
      { caseId: lead!.id, kind: 'template', body: preview, templateName: FOLLOW_UP_TEMPLATE },
    );
    return;
  }
  const titles = ['Done', 'Not done', 'Need help'];
  await sendButtons(
    ctx,
    employee,
    body,
    ids.map((choice, index) => ({ id: followUpGroupSelectionId(lead!.id, groupId, choice), title: titles[index]! })),
    lead!.id,
  );
}

/** A tap on a follow-up about several dates: the dates it asked about that are still waiting on it. */
export async function followUpGroupFor(ctx: EngineContext, leadId: string, groupId: string, employeeId: string): Promise<CaseRow[]> {
  const lead = await ctx.tx.query.cases.findFirst({ where: and(eq(cases.id, leadId), eq(cases.employeeId, employeeId)) });
  const ids = ((lead?.context as { followGroups?: Record<string, string[]> } | null)?.followGroups ?? {})[groupId] ?? [];
  if (!ids.length) return [];
  return ctx.tx.select().from(cases).where(and(inArray(cases.id, ids), eq(cases.status, 'answered'))).orderBy(asc(cases.attDate));
}

/** The answer to a follow-up about several dates: recorded on each, said back once. */
export async function handleFollowUpGroupResponse(ctx: EngineContext, rows: CaseRow[], employee: EmployeeRow, choice: FollowUpChoice) {
  if (!rows.length) {
    await sendPlainText(ctx, employee, 'These dates have already moved on, so please speak to your manager or HR about them.');
    return { choice };
  }
  for (const row of rows) await recordFollowUpChoice(ctx, row, choice);
  await sendPlainText(ctx, employee, followUpAcknowledgement(choice, datesLabel(rows)), rows[0]!.id);
  if (choice === 'done') await chainNextPending(ctx, employee, rows[0]!.id);
  return { choice };
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
  overdue?: CaseRow[],
  channel?: 'call' | 'whatsapp',
  /** The call style the caller's call rule gave; otherwise worked out here. */
  callStyle?: CallStyle | null,
): Promise<{ reached: true; simulated?: boolean } | { reached: false; reason: string; busy?: boolean }> {
  const { final } = nextFollowUp(caseRow, ctx.settings);
  let simulated: boolean | undefined;
  // A call only when the call rule says so, unless the caller has already decided.
  const ruled = channel && callStyle ? callStyle : callRuleFor(ctx as FullContext, employee, { reminders: [], followUps: [caseRow] }, at);
  const onCall = (channel ?? (ruled ? 'call' : 'whatsapp')) === 'call';

  if (onCall) {
    if (!ctx.voice || !ctx.baseUrl) return { reached: false, reason: 'No voice provider configured' };
    const callMode = callStyle ?? ruled ?? 'keypad';
    const result = await placeCaseCall(ctx as VoiceContext, caseRow, employee, final ? 'final_notice' : 'follow_up', callMode);
    if (!result.placed) return { reached: false, reason: result.reason, busy: 'busy' in result && result.busy };
    simulated = result.simulated;
  } else {
    const block = canSend(ctx, employee);
    if (block.blocked) return { reached: false, reason: block.reason };
    if (final) await sendFinalNotice(ctx, caseRow, employee, at);
    else await sendReminder(ctx, caseRow, employee, at);
  }

  await recordFollowUpSent(ctx, caseRow, employee, at, overdue, onCall ? 'call' : 'whatsapp');
  return { reached: true, simulated };
}

/**
 * The WhatsApp for follow-ups already counted - after a call about them rang
 * out. One message for those still open, and the final notice for those at it.
 */
export async function sendFollowUpWhatsapp(ctx: EngineContext, employee: EmployeeRow, rows: CaseRow[], at = new Date()) {
  if (canSend(ctx, employee).blocked || !rows.length) return;
  const last = rows.filter((row) => row.followUpCount >= ctx.settings.maxFollowUps);
  const open = rows.filter((row) => row.followUpCount < ctx.settings.maxFollowUps);
  if (open.length === 1) await sendReminder(ctx, open[0]!, employee, at);
  else if (open.length > 1) await sendReminderGroup(ctx, employee, open, at);
  if (last.length) await sendFinalNotice(ctx, last[0]!, employee, at, last.slice(1));
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
    // "Done": the next working day is left for the file to show it.
    sql`(${cases.followUpPausedUntil} is null or ${cases.followUpPausedUntil} < ${today(timezone, at)})`,
  );

/** The follow-ups HR sends from the dashboard: those whose day to act has passed. */
export const sendDueFollowUps = (ctx: FollowUpContext, at = new Date(), employeeId?: string, queueIfBusy = true) =>
  sendFollowUps(
    ctx,
    and(
      eq(cases.status, 'answered'),
      lte(cases.followUpDueAt, at),
      sql`(${cases.followUpPausedUntil} is null or ${cases.followUpPausedUntil} < ${today(ctx.settings.timezone, at)})`,
      employeeId ? eq(cases.employeeId, employeeId) : undefined,
    ),
    at,
    { mode: 'due', queueIfBusy },
  );

/** One person's follow-ups at their turn after an upload. */
export const sendFollowUpsAfterUpload = (
  ctx: FollowUpContext,
  employeeId: string,
  at = new Date(),
  queueIfBusy = true,
  skipCalls = false,
  /** Decided already by the person's daily contact; otherwise the call rule decides here. */
  channel?: 'call' | 'whatsapp',
  /** With `channel` 'call': the call style the daily contact's call rule gave. */
  callStyle?: CallStyle | null,
) =>
  sendFollowUps(ctx, and(followUpDueOnUpload(ctx.settings.timezone, at), eq(cases.employeeId, employeeId)), at, { mode: 'upload', queueIfBusy, skipCalls, channel, callStyle });

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
async function sendFollowUps(
  ctx: FollowUpContext,
  which: SQL | undefined,
  at: Date,
  /** `skipCalls`: the follow-ups due by call go on the absence call instead (`upload-send.ts`). */
  opts: { mode: 'due' | 'upload'; queueIfBusy: boolean; skipCalls?: boolean; channel?: 'call' | 'whatsapp'; callStyle?: CallStyle | null },
) {
  // A step a day, working days only: nothing goes, and nothing is counted, on other days.
  if (!isWorkingDay(today(ctx.settings.timezone, at), ctx.settings)) {
    return { due: 0, sent: 0, called: 0, waiting: 0, busy: false, skipped: ['Not a working day'] };
  }
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
  let waiting = 0;
  let busy = false;
  const skipped: string[] = [];
  // A reminder and a final notice are different calls, so one person may get one of each.
  const rungAlready = new Set<string>();
  // Whoever found every line busy waits for one; their other dates wait with them, for that one call.
  const waitingFor = new Set<string>();
  // On WhatsApp a person gets one follow-up for all their dates, and one final notice for those at the last.
  const written = new Map<string, { employee: EmployeeRow; open: CaseRow[]; last: CaseRow[] }>();
  // Per person: the call style, or null for WhatsApp.
  const decided = new Map<string, CallStyle | null>();
  // Who was reached, and the dates their call covered, for the call rule's own record.
  const contacted = new Map<string, { employee: EmployeeRow; called: CaseRow[] }>();
  // Dates whose follow-ups ran out, per person: one manager request for them.
  const overdue = new Map<string, { employee: EmployeeRow; rows: CaseRow[]; via: 'whatsapp' | 'call' }>();
  const overdueFor = (employee: EmployeeRow, via: 'whatsapp' | 'call') => {
    const entry = overdue.get(employee.id) ?? { employee, rows: [], via };
    overdue.set(employee.id, entry);
    return entry.rows;
  };

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
    // Call or WhatsApp, once per person: as decided by the caller, else by the call rule.
    if (!decided.has(employee.id)) {
      const theirs = due.filter((row) => row.employeeId === employee.id);
      decided.set(
        employee.id,
        opts.channel
          ? opts.channel === 'call'
            ? (opts.callStyle ?? callRuleFor(ctx as FullContext, employee, { reminders: [], followUps: theirs }, at) ?? 'keypad')
            : null
          : callRuleFor(ctx as FullContext, employee, { reminders: [], followUps: theirs }, at),
      );
    }
    const callStyle = decided.get(employee.id) ?? null;
    const onCall = callStyle !== null;
    if (onCall && opts.skipCalls) continue;
    const callKey = `${employee.id}:${next.final}`;
    if (onCall && waitingFor.has(employee.id)) continue;
    if (onCall && rungAlready.has(callKey)) {
      await recordFollowUpSent(ctx, caseRow, employee, at, overdueFor(employee, 'call'), 'call');
      contacted.get(employee.id)?.called.push(caseRow);
      continue;
    }
    if (!onCall) {
      const entry = written.get(employee.id) ?? { employee, open: [], last: [] };
      (next.final ? entry.last : entry.open).push(caseRow);
      written.set(employee.id, entry);
      continue;
    }

    try {
      const result = await sendFollowUp(ctx, caseRow, employee, at, overdueFor(employee, 'call'), 'call', callStyle);
      if (!result.reached && result.busy) {
        waitingFor.add(employee.id);
        busy = true;
        if (opts.queueIfBusy) {
          await waitForLine(ctx.tx, ctx.tenantId, { action: 'follow_ups', employeeId: employee.id, mode: opts.mode });
          waiting++;
        }
      } else if (!result.reached) {
        skipped.push(result.reason);
      } else if (onCall) {
        rungAlready.add(callKey);
        called++;
        contacted.set(employee.id, { employee, called: [...(contacted.get(employee.id)?.called ?? []), caseRow] });
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

  // WhatsApp: one follow-up per person for all their dates, and one final notice.
  for (const { employee, open, last } of written.values()) {
    try {
      if (open.length === 1) await sendReminder(ctx, open[0]!, employee, at);
      else if (open.length > 1) await sendReminderGroup(ctx, employee, open, at);
      if (last.length) await sendFinalNotice(ctx, last[0]!, employee, at, last.slice(1));
      for (const row of [...open, ...last]) await recordFollowUpSent(ctx, row, employee, at, overdueFor(employee, 'whatsapp'));
      sent += (open.length ? 1 : 0) + (last.length ? 1 : 0);
      if (!contacted.has(employee.id)) contacted.set(employee.id, { employee, called: [] });
    } catch (error) {
      // One refused message must not lose the rest of the batch; tried again at the next sweep.
      const reason = (error as Error).message;
      for (const row of [...open, ...last]) await ctx.tx.update(cases).set({ error: reason, updatedAt: new Date() }).where(eq(cases.id, row.id));
      skipped.push(reason);
    }
  }

  // The manager: one request per person for every date that ran out together.
  for (const { employee, rows, via } of overdue.values()) if (rows.length) await requestOverdue(ctx, employee, rows, via);

  // The call rule's record - a contact they may ignore, and the calls - unless the
  // person's daily contact sent these and keeps that record itself.
  if (!opts.channel) {
    for (const { employee, called: rows } of contacted.values()) await noteContacted(ctx as FullContext, employee, at, { reminders: [], called: rows, absence: false });
  }

  return { due: due.length, sent, called, waiting, busy, skipped };
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
