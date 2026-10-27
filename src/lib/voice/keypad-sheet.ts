import { and, count, eq, gte } from 'drizzle-orm';
import { cases } from '@/db/schema';
import { today } from '@/lib/dates';
import { managerFirstName } from '@/lib/approvals';
import { agentCanApply, leaveTypesFor, needsApplication, submitApplication, type ApplyContext } from '@/lib/conversation/apply';
import type { CaseRow, EmployeeRow } from '@/lib/conversation/engine';
import { instructionFor, OUTCOMES, type ApplicationStage, type LeaveChoice, type OutcomeCode } from '@/lib/conversation/outcomes';
import { MENUS, setState, sheetState, STEPS, type Menu, type SheetState, type Step, type StepName } from '@/lib/conversation/sheet';
import { addDays, recordOutcome } from '@/lib/conversation/talk';
import { datePrompt, spokenBacklogSummary, spokenClosing, spokenDate, spokenHandover, spokenNotUnderstood } from '@/lib/conversation/voice-script';
import { appendTurn, finishCall, pending, spokenFor, type CallRow, type CallTurn, type VoiceContext } from './session';

/**
 * The flow sheet on a keypad call: the same menus as WhatsApp (`sheet.ts`), read
 * out with a key for each choice, down to the same outcomes - and anything
 * applied for asks where it stands and goes to the manager, as it does there.
 *
 * Where they are in the menus is kept on the case, as WhatsApp keeps it, so a
 * date part-answered on one channel is picked up on the other.
 */

/** Written words, read out: "HRMS" as letters, a written date as a spoken one. */
const aloud = (text: string) => text.replace(/\bHRMS\b/g, 'H R M S').replace(/\bHR\b/g, 'H R');

/** A step's title as it is said after "press 1 for": "Resigned / left job" is "resigned, or left the job". */
const titleSaid = (step: Step) =>
  step.title
    .replace(' / ', ' or ')
    .replace("I'll", 'you will')
    .replace(/^It was my /, 'your ')
    .toLowerCase();

function keys(steps: StepName[]): string {
  return steps.map((name, index) => `Press ${index + 1} for ${titleSaid(STEPS[name])}.`).join(' ');
}

const spokenFacts = async (ctx: VoiceContext, caseRow: CaseRow, employee: EmployeeRow) => ({
  date: spokenFor(caseRow),
  deadline: spokenDate(addDays(today(ctx.settings.timezone), ctx.settings.followUpAfterDays)),
  manager: await managerFirstName(ctx.tx, ctx.tenantId, employee),
});

/** Reads a menu out, and remembers it is open. */
async function openMenu(
  ctx: VoiceContext,
  call: CallRow,
  caseRow: CaseRow,
  menu: Menu,
  state: Partial<SheetState> = {},
  lead?: string,
  body?: string,
): Promise<CallTurn> {
  const spec = MENUS[menu];
  const variant = spec.hrms && agentCanApply(ctx as ApplyContext) ? spec.hrms : spec;
  const question = `${aloud(body ?? variant.body(spokenFor(caseRow)))} ${keys(variant.steps)}`;
  await setState(ctx, caseRow.id, { menu, pendingOutcome: null, note: null, application: null, chatTurns: 0, ...state });
  await appendTurn(ctx, call.id, 'agent', [lead, question].filter(Boolean).join(' '));
  return { speak: question, intro: lead, nextCaseId: caseRow.id, done: false };
}

/** The steps the open menu offers, as the employee heard them. */
function stepsOf(ctx: VoiceContext, menu: Menu): StepName[] {
  const spec = MENUS[menu];
  return (spec.hrms && agentCanApply(ctx as ApplyContext) ? spec.hrms : spec).steps;
}

/** After a date is settled: the next one, or goodbye. */
async function moveOn(ctx: VoiceContext, call: CallRow, caseRow: CaseRow, employee: EmployeeRow, told: string, code: OutcomeCode): Promise<CallTurn> {
  const outstanding = code === 'resigned' ? [] : await pending(ctx, employee.id, caseRow.id);
  // Dates this employee answered since the call began, this one among them.
  const since = call.startedAt ?? new Date(Date.now() - 30 * 60_000);
  const [row] = await ctx.tx
    .select({ cleared: count() })
    .from(cases)
    .where(and(eq(cases.employeeId, employee.id), gte(cases.answeredAt, since)));
  const cleared = Math.max(row?.cleared ?? 0, 1);
  const cap = ctx.settings.maxDatesPerCall;
  if (!outstanding.length || (cap > 0 && cleared >= cap)) {
    const closing = `${told} ${spokenClosing(cleared, outstanding.length)}`;
    await appendTurn(ctx, call.id, 'agent', closing);
    await finishCall(ctx, call.id, outstanding.length ? 'not_completed' : 'completed_confirmed');
    return { speak: closing, nextCaseId: null, done: true };
  }
  const next = outstanding[0]!;
  const intro = `${told} ${spokenBacklogSummary(outstanding.length)}`;
  const question = datePrompt(spokenFor(next), 'keypad');
  await appendTurn(ctx, call.id, 'agent', `${intro} ${question}`);
  return { speak: question, intro, nextCaseId: next.id, done: false };
}

/** Records an outcome that needs nothing applied for, says what to do, and moves on. */
async function settle(
  ctx: VoiceContext,
  call: CallRow,
  caseRow: CaseRow,
  employee: EmployeeRow,
  code: OutcomeCode,
  choice: LeaveChoice | null,
  note: string | null,
  stage?: ApplicationStage,
): Promise<CallTurn> {
  if (needsApplication(code, choice)) {
    const known = stage ?? OUTCOMES[code].application!.preset;
    if (!known) {
      const facts = await spokenFacts(ctx, caseRow, employee);
      const what = OUTCOMES[code].application!.what;
      const body = agentCanApply(ctx as ApplyContext)
        ? `Shall I apply the ${what} for ${facts.date} for you, and send it to ${facts.manager ?? 'your manager'} for approval?`
        : `Have you applied the ${what} for ${facts.date} yet?`;
      return openMenu(ctx, call, caseRow, 'apply', { application: { code, choice }, note }, undefined, body);
    }
    return settleApplication(ctx, call, caseRow, employee, code, choice, note, known);
  }
  const facts = await spokenFacts(ctx, caseRow, employee);
  await setState(ctx, caseRow.id, null);
  const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) })) ?? caseRow;
  await recordOutcome(ctx, fresh, employee, code, choice, note, facts.manager, 'call');
  return moveOn(ctx, call, caseRow, employee, aloud(instructionFor(code, choice, facts)), code);
}

async function settleApplication(
  ctx: VoiceContext,
  call: CallRow,
  caseRow: CaseRow,
  employee: EmployeeRow,
  code: OutcomeCode,
  choice: LeaveChoice | null,
  note: string | null,
  stage: ApplicationStage,
  leaveType?: string,
): Promise<CallTurn> {
  const apply = ctx as ApplyContext;
  if (stage === 'apply_for_me' && agentCanApply(apply) && OUTCOMES[code].application!.action === 'apply_leave' && !leaveType) {
    const types = (await leaveTypesFor(apply, employee)).slice(0, 9);
    if (types.length) {
      const question = `Which leave shall I apply for ${spokenFor(caseRow)}? ${types
        .map((t, index) => `Press ${index + 1} for ${t.type}, ${t.days} days left.`)
        .join(' ')}`;
      await setState(ctx, caseRow.id, { menu: 'leave_type', application: { code, choice, stage }, note, chatTurns: 0 });
      await appendTurn(ctx, call.id, 'agent', question);
      return { speak: question, nextCaseId: caseRow.id, done: false };
    }
    stage = 'not_applied';
  }
  const facts = await spokenFacts(ctx, caseRow, employee);
  await setState(ctx, caseRow.id, null);
  const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) })) ?? caseRow;
  await recordOutcome(ctx, fresh, employee, code, choice, note, facts.manager, 'call');
  const reply = await submitApplication(apply, fresh, employee, { code, choice, stage, leaveType, note, via: 'call', facts });
  return moveOn(ctx, call, caseRow, employee, aloud(reply), code);
}

/** The first question's answer: which branch of the sheet to read out. */
export async function keypadTopOption(ctx: VoiceContext, call: CallRow, caseRow: CaseRow, option: 1 | 2 | 3 | 4): Promise<CallTurn> {
  const menu: Menu = option === 1 ? 'absent' : option === 2 ? 'working' : option === 3 ? 'on_leave' : 'weekly';
  return openMenu(ctx, call, caseRow, menu);
}

/**
 * A key pressed - or a word said - while a menu is open. Null when no menu is
 * open, and the caller asks the first question.
 */
export async function keypadMenuTurn(
  ctx: VoiceContext,
  call: CallRow,
  caseRow: CaseRow,
  employee: EmployeeRow,
  input: { digits?: string; speech?: string },
): Promise<CallTurn | null> {
  const state = sheetState(caseRow);
  if (!state?.menu) return null;

  // Which leave, for the agent to apply.
  if (state.menu === 'leave_type' && state.application) {
    const types = (await leaveTypesFor(ctx as ApplyContext, employee)).slice(0, 9);
    const chosen = types[Number(input.digits) - 1];
    if (chosen) {
      const { code, choice } = state.application;
      return settleApplication(ctx, call, caseRow, employee, code, choice, state.note ?? null, 'apply_for_me', chosen.type);
    }
    return notUnderstood(ctx, call, caseRow, state);
  }

  const steps = stepsOf(ctx, state.menu);
  const byKey = steps[Number(input.digits) - 1];
  // A word said rather than a key: the step whose title it names.
  const said = (input.speech ?? '').toLowerCase();
  const bySpeech = !byKey && said ? steps.find((name) => said.includes(STEPS[name].title.toLowerCase().split(' ')[0]!)) : undefined;
  const name = byKey ?? bySpeech;
  if (!name) return notUnderstood(ctx, call, caseRow, state);
  const step: Step = STEPS[name];

  if (step.choice) {
    if (!state.pendingOutcome) return openMenu(ctx, call, caseRow, 'absent');
    return settle(ctx, call, caseRow, employee, state.pendingOutcome, step.choice, state.note ?? null);
  }
  // "Other reason" cannot be typed on a keypad: it is noted as such, and leave or Loss of Pay is next.
  if (step.menu === 'other_reason') {
    return openMenu(ctx, call, caseRow, 'leave_or_lop', { pendingOutcome: 'absent_other', note: 'Another reason, given on a keypad call' });
  }
  if (step.menu) return openMenu(ctx, call, caseRow, step.menu);
  if (step.stage && !step.outcome) {
    if (!state.application) return openMenu(ctx, call, caseRow, 'absent');
    const { code, choice } = state.application;
    return settleApplication(ctx, call, caseRow, employee, code, choice, state.note ?? null, step.stage);
  }
  const code = step.outcome!;
  if (OUTCOMES[code].asksLeaveOrLossOfPay) {
    return openMenu(ctx, call, caseRow, 'leave_or_lop', { pendingOutcome: code, note: state.note ?? null });
  }
  return settle(ctx, call, caseRow, employee, code, null, null, step.stage);
}

/** A key that means nothing here: once, the menu again; twice, H R takes it. */
async function notUnderstood(ctx: VoiceContext, call: CallRow, caseRow: CaseRow, state: SheetState): Promise<CallTurn> {
  const misses = (call.transcript ?? []).filter((t) => t.role === 'agent' && t.text.startsWith('Sorry')).length;
  if (misses >= 2) {
    await setState(ctx, caseRow.id, null);
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: 'Could not answer the keypad menus', updatedAt: new Date() })
      .where(eq(cases.id, caseRow.id));
    await appendTurn(ctx, call.id, 'agent', spokenHandover());
    await finishCall(ctx, call.id, 'needs_help');
    return { speak: spokenHandover(), nextCaseId: null, done: true };
  }
  const sorry = spokenNotUnderstood('spoken');
  const spec = MENUS[state.menu!];
  const variant = spec.hrms && agentCanApply(ctx as ApplyContext) ? spec.hrms : spec;
  const question =
    state.menu === 'leave_type'
      ? 'Please press the number for the leave you want.'
      : state.menu === 'apply'
        ? `Please press a key. ${keys(variant.steps)}`
        : `${aloud(variant.body(spokenFor(caseRow)))} ${keys(variant.steps)}`;
  await appendTurn(ctx, call.id, 'agent', `${sorry} ${question}`);
  return { speak: question, intro: sorry, nextCaseId: caseRow.id, done: false, retry: true };
}
