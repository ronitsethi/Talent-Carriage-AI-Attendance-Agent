import { eq } from 'drizzle-orm';
import { cases, conversations, employees } from '@/db/schema';
import { today } from '@/lib/dates';
import type { Meaning } from '@/lib/mapping/meanings';
import {
  chainNextPending,
  getConversation,
  sendButtons,
  sendList,
  sendPlainText,
  type CaseRow,
  type EmployeeRow,
  type EngineContext,
} from './engine';
import { dateLabel, formatDate, type OptionNumber } from './flow';
import { instructionFor, OUTCOMES, type LeaveChoice, type OutcomeCode } from './outcomes';
import { recordOutcome } from './talk';

/**
 * The customer's flow sheet, as WhatsApp menus.
 *
 * The first question is still the approved template with its four buttons -
 * changing those needs Meta to approve a new template. What follows a tap is
 * the sheet: "Yes, I was absent" asks what happened, "No, I was working" asks
 * how, and so on down to an outcome, which is recorded exactly as a talking
 * call records it (`outcomes.ts`).
 *
 * Typing is always allowed, at any point: the message goes to the same
 * conversation a call has (`talk.ts`, in chat mode), which may land straight on
 * an outcome, ask what is missing, or answer a question - and the menus pick up
 * from wherever it leaves off.
 */

export type Menu = 'absent' | 'working' | 'late_early' | 'punch' | 'outside' | 'leave_or_lop' | 'other_reason';

/** Kept on the case while the employee is part-way down the sheet. */
export type SheetState = {
  /** Null once they are typing rather than tapping, with no menu open. */
  menu: Menu | null;
  /** An absence waiting on "leave or Loss of Pay". */
  pendingOutcome?: OutcomeCode | null;
  note?: string | null;
  /** Typed messages since the last menu, so a conversation going nowhere reaches HR. */
  chatTurns?: number;
};

type Step = { title: string; description?: string; outcome?: OutcomeCode; menu?: Menu; choice?: LeaveChoice };

/** Every row and button the menus offer. Button titles run to 20 characters, list rows to 24. */
const STEPS = {
  unwell: { title: 'Unwell', outcome: 'absent_unwell' },
  family: { title: 'Family emergency', outcome: 'absent_family_emergency' },
  personal: { title: 'Personal work', outcome: 'absent_personal_work' },
  other: { title: 'Other reason', description: 'Type the reason', menu: 'other_reason' },
  resigned: { title: 'Resigned / left job', description: 'Resigned or joined another company', outcome: 'resigned' },
  weekly_off: { title: 'It was my weekly off', outcome: 'weekly_off' },
  comp_off: { title: 'Comp off', outcome: 'comp_off' },
  late_early: { title: 'Late / left early', menu: 'late_early' },
  punch: { title: 'Missed punch', menu: 'punch' },
  outside: { title: 'Worked outside', menu: 'outside' },
  late: { title: 'Came late', outcome: 'came_late' },
  early: { title: 'Left early', outcome: 'left_early' },
  late_both: { title: 'Both', outcome: 'late_and_early' },
  punch_in: { title: 'In-punch', outcome: 'missed_in_punch' },
  punch_out: { title: 'Out-punch', outcome: 'missed_out_punch' },
  punch_both: { title: 'Both punches', outcome: 'missed_both_punches' },
  client: { title: 'Client visit', outcome: 'on_duty_client_visit' },
  field: { title: 'Field work', outcome: 'on_duty_field_work' },
  travel: { title: 'Official travel', outcome: 'on_duty_official_travel' },
  training: { title: 'Company training', outcome: 'on_duty_training' },
  leave: { title: 'Apply leave', choice: 'leave' },
  lop: { title: 'Loss of Pay', choice: 'loss_of_pay' },
} satisfies Record<string, Step>;

export type StepName = keyof typeof STEPS;

const MENUS: Record<Menu, { kind: 'list' | 'buttons' | 'text'; body: (label: string) => string; steps: StepName[]; where: string }> = {
  absent: {
    kind: 'list',
    body: (label) => `Sorry to hear that. What happened on ${label}?`,
    steps: ['unwell', 'family', 'personal', 'other', 'resigned', 'weekly_off', 'comp_off'],
    where: 'chose "Yes, I was absent"; asked what happened',
  },
  working: {
    kind: 'buttons',
    body: (label) => `Thanks. What happened on ${label}?`,
    steps: ['late_early', 'punch', 'outside'],
    where: 'chose "No, I was working"; asked whether they came late or left early, missed a punch, or worked outside',
  },
  late_early: {
    kind: 'buttons',
    body: (label) => `Did you come late, leave early, or both on ${label}?`,
    steps: ['late', 'early', 'late_both'],
    where: 'said they came late or left early; asked which',
  },
  punch: {
    kind: 'buttons',
    body: (label) => `Which punch was missed on ${label}?`,
    steps: ['punch_in', 'punch_out', 'punch_both'],
    where: 'said they worked in office but missed a punch; asked which punch',
  },
  outside: {
    kind: 'list',
    body: (label) => `Where were you working on ${label}?`,
    steps: ['client', 'field', 'travel', 'training'],
    where: 'said they worked outside the office; asked whether client visit, field work, official travel or training',
  },
  leave_or_lop: {
    kind: 'buttons',
    body: (label) => `Would you like to apply leave for ${label}, or should it be treated as Loss of Pay?`,
    steps: ['leave', 'lop'],
    where: 'reason is known; asked whether they will apply leave or take Loss of Pay',
  },
  other_reason: {
    kind: 'text',
    body: (label) => `Please type the reason for ${label} in a message.`,
    steps: [],
    where: 'chose "Other reason"; asked to type the reason',
  },
};

export function sheetSelectionId(caseId: string, step: StepName): string {
  return `sheet:${caseId}:${step}`;
}

export function parseSheetSelectionId(value: string | undefined | null): { caseId: string; step: StepName } | null {
  const match = /^sheet:([0-9a-f-]{36}):([a-z_]{1,20})$/i.exec(value ?? '');
  if (!match || !(match[2]! in STEPS)) return null;
  return { caseId: match[1]!, step: match[2] as StepName };
}

export function sheetState(caseRow: CaseRow): SheetState | null {
  return ((caseRow.context ?? {}) as { sheet?: SheetState }).sheet ?? null;
}

/** Where they are, in words, for the conversation to pick up from. */
export function describeMenu(state: SheetState | null): string | null {
  if (!state?.menu) return null;
  const pending = state.pendingOutcome ? ` (reason so far: ${OUTCOMES[state.pendingOutcome].label})` : '';
  return `${MENUS[state.menu].where}${pending}`;
}

const label = (caseRow: CaseRow) => dateLabel(caseRow.attDate, caseRow.meaning as Meaning);

async function setState(ctx: EngineContext, caseId: string, state: SheetState | null) {
  const fresh = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId), columns: { context: true } });
  const { sheet: _old, ...rest } = (fresh?.context ?? {}) as Record<string, unknown>;
  await ctx.tx
    .update(cases)
    .set({ context: state ? { ...rest, sheet: state } : rest, updatedAt: new Date() })
    .where(eq(cases.id, caseId));
}

/** Sends one menu, with `body` in place of its usual question when the conversation wrote one. */
export async function openMenu(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  menu: Menu,
  opts: { body?: string; pendingOutcome?: OutcomeCode | null; note?: string | null } = {},
) {
  const spec = MENUS[menu];
  const body = opts.body ?? spec.body(label(caseRow));
  const items = spec.steps.map((step) => {
    const s: Step = STEPS[step];
    return { id: sheetSelectionId(caseRow.id, step), title: s.title, description: s.description };
  });

  if (spec.kind === 'list') await sendList(ctx, employee, body, items, caseRow.id);
  else if (spec.kind === 'buttons') {
    await sendButtons(ctx, employee, body, items.map(({ id, title }) => ({ id, title })), caseRow.id);
  } else await sendPlainText(ctx, employee, body, caseRow.id);

  await setState(ctx, caseRow.id, { menu, pendingOutcome: opts.pendingOutcome ?? null, note: opts.note ?? null, chatTurns: 0 });
  // Whatever they type next is about this date, not whichever was asked last.
  const conversation = await getConversation(ctx, employee.id);
  await ctx.tx.update(conversations).set({ activeCaseId: caseRow.id, updatedAt: new Date() }).where(eq(conversations.id, conversation.id));
}

/** The facts the sheet's replies are written with, as a chat writes dates. */
export async function writtenFacts(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, answeredOn?: string) {
  const from = answeredOn ?? today(ctx.settings.timezone);
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ctx.settings.followUpAfterDays);
  const manager = employee.managerEmployeeId
    ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, employee.managerEmployeeId), columns: { fullName: true } })
    : null;
  return {
    date: label(caseRow),
    deadline: formatDate(d.toISOString().slice(0, 10)),
    manager: manager?.fullName.split(/\s+/)[0] ?? null,
  };
}

/**
 * Records an outcome, tells the employee what to do, and moves on to their next
 * date. `reply`, when the conversation wrote one, is sent instead of the
 * sheet's wording - it says the same thing, in their language.
 */
export async function settle(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  code: OutcomeCode,
  choice: LeaveChoice | null,
  note: string | null,
  reply?: string,
) {
  const facts = await writtenFacts(ctx, caseRow, employee);
  await setState(ctx, caseRow.id, null);
  const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) })) ?? caseRow;
  await recordOutcome(ctx, fresh, employee, code, choice, note, facts.manager, 'whatsapp');
  await sendPlainText(ctx, employee, reply ?? instructionFor(code, choice, facts), caseRow.id);

  // Somebody who has left needs HR, not their other dates.
  if (code !== 'resigned') await chainNextPending(ctx, employee, caseRow.id);
}

/** One of the first question's four options. */
export async function handleTopOption(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, option: OptionNumber) {
  if (option === 1) return openMenu(ctx, caseRow, employee, 'absent');
  if (option === 2) return openMenu(ctx, caseRow, employee, 'working');
  if (option === 3) return settle(ctx, caseRow, employee, 'leave_pending_approval', null, null);
  return settle(ctx, caseRow, employee, 'regularisation_already_sent', null, null);
}

/** A row or button from one of the sheet's menus. */
export async function handleStep(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, name: StepName) {
  const step: Step = STEPS[name];
  const state = sheetState(caseRow);

  if (step.choice) {
    // Leave or Loss of Pay, for the absence asked about. Without one, ask again from the top.
    if (!state?.pendingOutcome) return openMenu(ctx, caseRow, employee, 'absent');
    return settle(ctx, caseRow, employee, state.pendingOutcome, step.choice, state.note ?? null);
  }
  if (step.menu) return openMenu(ctx, caseRow, employee, step.menu);

  const code = step.outcome!;
  if (OUTCOMES[code].asksLeaveOrLossOfPay) {
    return openMenu(ctx, caseRow, employee, 'leave_or_lop', { pendingOutcome: code, note: state?.note ?? null });
  }
  return settle(ctx, caseRow, employee, code, null, null);
}

/** How long a typed exchange may go on without settling the date before HR takes it. */
const MAX_CHAT_TURNS = 6;

export type TypedResult = 'answered' | 'clarified' | 'handed_to_hr' | null;

/**
 * A typed message about a date. Null when the conversation could not be had,
 * and the engine falls back on its classifier.
 */
export async function handleTyped(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  text: string,
  inboundMessageId: string,
): Promise<TypedResult> {
  const state = sheetState(caseRow);

  // "Other reason": what they type is the reason; leave or Loss of Pay is next.
  if (state?.menu === 'other_reason') {
    await openMenu(ctx, caseRow, employee, 'leave_or_lop', { pendingOutcome: 'absent_other', note: text.slice(0, 300) });
    return 'clarified';
  }

  if (!ctx.hooks?.converse) return null;
  const verdict = await ctx.hooks.converse(ctx, { caseRow, employee, text, menu: describeMenu(state), inboundMessageId });
  if (!verdict) return null;

  if (verdict.action === 'handover') {
    await setState(ctx, caseRow.id, null);
    await ctx.tx
      .update(cases)
      .set({
        status: 'needs_hr',
        needsHrReason: (verdict.handoverReason ?? 'Asked for HR on WhatsApp').slice(0, 300),
        replyText: text,
        aiUsed: true,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseRow.id));
    await sendPlainText(ctx, employee, verdict.reply, caseRow.id);
    return 'handed_to_hr';
  }

  // A choice of leave or Loss of Pay typed in answer to that menu belongs to the absence it asked about.
  const code = verdict.outcome ?? (state?.menu === 'leave_or_lop' && verdict.leaveChoice ? state.pendingOutcome ?? null : null);
  const note = verdict.note ?? state?.note ?? null;
  if (code) {
    if (OUTCOMES[code].asksLeaveOrLossOfPay && !verdict.leaveChoice) {
      // Their words, with the two buttons under them.
      await openMenu(ctx, caseRow, employee, 'leave_or_lop', { body: verdict.reply, pendingOutcome: code, note });
      return 'clarified';
    }
    await settle(ctx, caseRow, employee, code, verdict.leaveChoice, note, verdict.reply);
    return 'answered';
  }

  await sendPlainText(ctx, employee, verdict.reply, caseRow.id);
  const turns = (state?.chatTurns ?? 0) + 1;
  if (turns >= MAX_CHAT_TURNS) {
    await setState(ctx, caseRow.id, null);
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: 'Not settled after several messages', replyText: text, aiUsed: true, updatedAt: new Date() })
      .where(eq(cases.id, caseRow.id));
    return 'handed_to_hr';
  }
  if (state) await setState(ctx, caseRow.id, { ...state, chatTurns: turns });
  else await setState(ctx, caseRow.id, { menu: null, chatTurns: turns, pendingOutcome: null, note: null });
  return 'clarified';
}
