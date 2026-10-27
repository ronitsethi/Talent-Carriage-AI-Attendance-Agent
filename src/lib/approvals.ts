import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { actions, approvals, cases, employees, managers, messages } from '@/db/schema';
import type { Meaning } from '@/lib/mapping/meanings';
import type { HrmsConnector } from '@/lib/hrms/types';
import type { Outbound } from '@/lib/channels/types';
import { approvalSelectionId, dateLabel, firstName } from '@/lib/conversation/flow';
import { canSend, deliver, getConversation, sendPlainText, windowOpen, type CaseRow, type EmployeeRow, type EngineContext } from '@/lib/conversation/engine';
import type { VoiceProvider } from '@/lib/voice/types';
import { decisionSentence, placeApprovalCall } from '@/lib/voice/approval-calls';
import type { VoiceContext } from '@/lib/voice/session';
import { instructionFor, OUTCOMES, type ApplicationStage, type LeaveChoice, type OutcomeCode } from '@/lib/conversation/outcomes';
import { executeAction } from '@/lib/actions/engine';

/**
 * The manager's side of every leave, regularisation, On-Duty and comp-off.
 *
 * Once an employee has said what happened and where the application stands,
 * their manager is asked to approve it: on WhatsApp, with Approved and Rejected
 * buttons. With a file for attendance, the manager approves in their own HRMS
 * and taps Approved to say so; with an HRMS connected and the agent asked to
 * apply it, Approved is what makes the agent apply it.
 *
 * Who the manager is comes from the attendance file: the manager mobile column
 * when there is one, else the manager code looked up among the employee codes.
 * A manager is known by their number, because they may not be in the file.
 */

export type ManagerRow = typeof managers.$inferSelect;
type Ctx = EngineContext & { hrms?: HrmsConnector | null; voice?: VoiceProvider; voiceAgent?: VoiceProvider | null; baseUrl?: string };

/** Whether this context can place calls: it carries a phone line and the address calls come back to. */
const canCall = (ctx: Ctx): ctx is Ctx & VoiceContext => Boolean(ctx.voice && ctx.baseUrl);

/** The template a decision goes as when the employee's 24-hour window has closed. */
export const OUTCOME_TEMPLATE = 'approval_outcome';

/** The approval request template, which must be approved by Meta before it reaches anybody. */
export const MANAGER_TEMPLATE = 'manager_approval_request';

/** The note to a manager that their decision is recorded, when their window has closed. */
export const NOTED_TEMPLATE = 'approval_noted';
export const NOTED_TEMPLATE_BODY =
  'Thank you. Your decision has been recorded by the attendance assistant.\n\n{{1}}\n\n' +
  'This is an automatic confirmation, and there is nothing more you need to do.';
const notedBody = (note: string) => NOTED_TEMPLATE_BODY.replace('{{1}}', note);

/**
 * The approval request's wording, with its four variables: who, what they did,
 * the date, and the reason. Meta refuses a template with too many variables for
 * its length, so the instruction is fixed text rather than one of them.
 */
export const MANAGER_TEMPLATE_BODY =
  'Hello, this is the attendance assistant with an approval request for your team member.\n\n' +
  '{{1}} {{2}} for {{3}}.\nReason given: {{4}}\n\n' +
  'If you approve it, please approve it in your HRMS and then tap Approved below. Where they asked us to apply it for them, ' +
  'tapping Approved is enough and we will apply it in the HRMS ourselves. If you are not approving it, tap Rejected and we will let them know.';

export const managerRequestBody = (variables: string[]) =>
  MANAGER_TEMPLATE_BODY.replace(/\{\{(\d)\}\}/g, (_, n: string) => variables[Number(n) - 1] ?? '');

/**
 * The employee's manager, made sure of in the managers table. Null when the
 * file gives no way to reach one.
 */
export async function managerFor(tx: Db, tenantId: string, employee: EmployeeRow): Promise<ManagerRow | null> {
  const byCode = employee.managerEmployeeId
    ? await tx.query.employees.findFirst({ where: eq(employees.id, employee.managerEmployeeId) })
    : null;
  const mobile = employee.managerMobileE164 || byCode?.mobileE164 || null;
  if (!mobile) return null;
  // A name, from whoever in the file has that number - the manager by code, or anybody else.
  const named =
    byCode?.mobileE164 === mobile
      ? byCode
      : await tx.query.employees.findFirst({
          where: and(eq(employees.tenantId, tenantId), eq(employees.mobileE164, mobile), isNull(employees.deletedAt)),
        });
  const [row] = await tx
    .insert(managers)
    .values({ tenantId, mobileE164: mobile, fullName: named?.fullName ?? 'Manager', employeeId: named?.id ?? null })
    .onConflictDoUpdate({
      target: [managers.tenantId, managers.mobileE164],
      // Keep a name already known if this time there is none.
      set: named
        ? { fullName: named.fullName, employeeId: named.id, updatedAt: new Date() }
        : { updatedAt: sql`${managers.updatedAt}` },
    })
    .returning();
  return row ?? null;
}

/**
 * The manager's first name, for what the employee is told - by the same rule as
 * `managerFor`, without writing anything. Null when the file names nobody.
 */
export async function managerFirstName(tx: Db, tenantId: string, employee: EmployeeRow): Promise<string | null> {
  const byCode = employee.managerEmployeeId
    ? await tx.query.employees.findFirst({ where: eq(employees.id, employee.managerEmployeeId), columns: { fullName: true, mobileE164: true } })
    : null;
  const mobile = employee.managerMobileE164 || byCode?.mobileE164 || null;
  let name = byCode && (!employee.managerMobileE164 || byCode.mobileE164 === mobile) ? byCode.fullName : null;
  if (!name && mobile) {
    const known = await tx.query.managers.findFirst({ where: and(eq(managers.tenantId, tenantId), eq(managers.mobileE164, mobile)), columns: { fullName: true } });
    const asEmployee = known && known.fullName !== 'Manager'
      ? null
      : await tx.query.employees.findFirst({ where: and(eq(employees.tenantId, tenantId), eq(employees.mobileE164, mobile)), columns: { fullName: true } });
    name = known && known.fullName !== 'Manager' ? known.fullName : asEmployee?.fullName ?? null;
  }
  return name ? name.split(/\s+/)[0] ?? null : null;
}

type Request = {
  code: OutcomeCode;
  choice: LeaveChoice | null;
  stage: ApplicationStage;
  leaveType?: string | null;
  note: string | null;
  via: 'whatsapp' | 'call';
};

/**
 * What the employee is told once they have said where it stands. Written for
 * WhatsApp; on a call the agent says the same in its own words.
 */
export function applicationReply(
  request: Pick<Request, 'code' | 'choice' | 'stage' | 'leaveType'>,
  f: { date: string; deadline: string; manager: string | null },
  managerReached: boolean,
): string {
  const application = OUTCOMES[request.code].application!;
  const who = f.manager ?? 'your manager';
  // A leave type chosen from the HRMS names the leave: "your CL for 08-Sep-2026".
  const what = request.leaveType && application.what === 'leave' ? request.leaveType : application.what;
  if (!managerReached) {
    const base = request.stage === 'applied' ? `Okay, noted that you have applied the ${what} for ${f.date}.` : instructionFor(request.code, request.choice, f);
    return `${base} HR will follow up on the approval.`;
  }
  if (request.stage === 'applied') return `Okay. I have asked ${who} to approve your ${what} for ${f.date}.`;
  if (request.stage === 'apply_for_me') {
    return `Okay. I have sent your ${what} for ${f.date} to ${who} for approval, and will apply it in the HRMS once they approve.`;
  }
  return `${instructionFor(request.code, request.choice, f)} I have also let ${who} know, so they can approve it once you have.`;
}

/**
 * Creates the request and asks the manager. Returns whether a manager could be
 * asked - without one, the case goes to HR instead of stalling.
 */
export async function requestManagerApproval(
  ctx: Ctx,
  caseRow: CaseRow,
  employee: EmployeeRow,
  request: Request,
): Promise<{ managerReached: boolean; manager: ManagerRow | null; approvalId: string | null }> {
  const application = OUTCOMES[request.code].application;
  if (!application) throw new Error(`${request.code} is not applied for`);
  const manager = await managerFor(ctx.tx, ctx.tenantId, employee);
  const at = new Date();
  const agentApplies = request.stage === 'apply_for_me' && Boolean(ctx.hrms);

  // One request per employee, date and thing applied for, however often it is said.
  const idempotencyKey = `${application.action}:${employee.id}:${caseRow.attDate}`;
  const inputs = {
    date: caseRow.attDate,
    what: application.what,
    stage: request.stage,
    outcome: request.code,
    leaveType: request.leaveType ?? undefined,
    reason: request.note ?? OUTCOMES[request.code].label,
  };
  const [action] = await ctx.tx
    .insert(actions)
    .values({
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      employeeId: employee.id,
      type: application.action,
      status: 'awaiting_approval',
      inputs,
      requestedVia: request.via === 'call' ? 'voice' : 'whatsapp',
      idempotencyKey,
      connector: agentApplies ? ctx.hrms!.name : null,
    })
    .onConflictDoUpdate({
      target: [actions.tenantId, actions.idempotencyKey],
      set: { status: 'awaiting_approval', inputs, caseId: caseRow.id, updatedAt: at },
    })
    .returning();

  if (!manager) {
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: 'No manager in the file to approve it', followUpDueAt: null, callDueAt: null, updatedAt: at })
      .where(eq(cases.id, caseRow.id));
    return { managerReached: false, manager: null, approvalId: null };
  }

  // A request asked again replaces the one still waiting, rather than adding a second.
  await ctx.tx
    .update(approvals)
    .set({ decision: 'expired', respondedAt: at })
    .where(and(eq(approvals.actionId, action!.id), eq(approvals.decision, 'pending')));
  const [approval] = await ctx.tx
    .insert(approvals)
    .values({
      tenantId: ctx.tenantId,
      actionId: action!.id,
      approverEmployeeId: manager.employeeId,
      approverManagerId: manager.id,
      channel: 'whatsapp',
      timeoutAt: new Date(at.getTime() + ctx.settings.approvalTimeoutHours * 3600_000),
    })
    .returning();
  await ctx.tx
    .update(cases)
    .set({ status: 'awaiting_approval', followUpDueAt: null, callDueAt: null, updatedAt: at })
    .where(eq(cases.id, caseRow.id));

  // A manager set to manual waits for HR to send it, from the Managers page.
  if (manager.operatingMode === 'automatic') await sendApprovalRequest(ctx, approval!.id);
  return { managerReached: true, manager, approvalId: approval!.id };
}

/** What the manager is told an employee has done, by where it stands. */
function requestPhrase(stage: ApplicationStage, what: string, leaveType: string | undefined): string {
  const named = leaveType && what === 'leave' ? `${leaveType} leave` : what;
  if (stage === 'applied') return `has applied ${named}`;
  if (stage === 'apply_for_me') return `has asked us to apply ${named}`;
  return `has been asked to apply ${named}`;
}

/**
 * Sends a waiting request to its manager, the way set for them: a call, or
 * WhatsApp - as the approved template, because a manager is rarely inside the
 * 24-hour window. A call that cannot be placed, or `via` WhatsApp (what a call
 * the manager did not decide falls back to), goes on WhatsApp.
 */
export async function sendApprovalRequest(ctx: Ctx, approvalId: string, via?: 'whatsapp'): Promise<{ sent: boolean; error?: string }> {
  const approval = await ctx.tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
  if (!approval?.approverManagerId || approval.decision !== 'pending') return { sent: false, error: 'not waiting' };
  const action = await ctx.tx.query.actions.findFirst({ where: eq(actions.id, approval.actionId) });
  const manager = await ctx.tx.query.managers.findFirst({ where: eq(managers.id, approval.approverManagerId) });
  const employee = action ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, action.employeeId) }) : null;
  const caseRow = action?.caseId ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, action.caseId) }) : null;
  if (!action || !manager || !employee || !caseRow) return { sent: false, error: 'missing records' };

  if (manager.preferredChannel === 'voice' && via !== 'whatsapp' && canCall(ctx)) {
    const talk = (manager.callMode ?? ctx.settings.callMode) === 'agent';
    const placed = await placeApprovalCall(ctx, 'manager_approval', caseRow, employee, manager.mobileE164, talk);
    if (placed.placed) {
      await ctx.tx.update(approvals).set({ channel: 'voice', sentAt: new Date() }).where(eq(approvals.id, approval.id));
      return { sent: true };
    }
  }

  const inputs = action.inputs as { what: string; stage: ApplicationStage; leaveType?: string; reason?: string };
  const date = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const one = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300) || '-';
  const variables = [`${employee.fullName} (${employee.empCode})`, requestPhrase(inputs.stage, inputs.what, inputs.leaveType), date, inputs.reason ?? '-'].map(one);
  const preview = managerRequestBody(variables);
  const message: Outbound = {
    kind: 'template',
    to: manager.mobileE164,
    templateName: MANAGER_TEMPLATE,
    language: 'en',
    variables,
    buttonPayloads: [approvalSelectionId(approval.id, 'approve'), approvalSelectionId(approval.id, 'reject')],
    preview,
  };

  let providerMessageId: string | null = null;
  let error: string | undefined;
  let status: 'sent' | 'simulated' | 'failed' = 'sent';
  try {
    const result = await ctx.channel.send(message);
    providerMessageId = result.providerMessageId;
    if (result.simulated) status = 'simulated';
  } catch (problem) {
    error = (problem as Error).message.slice(0, 500);
    status = 'failed';
  }
  // Kept as a message with no case, so it never appears in the employee's own chat.
  await ctx.tx.insert(messages).values({
    tenantId: ctx.tenantId,
    direction: 'outbound',
    channel: 'whatsapp',
    kind: 'template',
    status,
    providerMessageId,
    waId: manager.mobileE164,
    templateName: MANAGER_TEMPLATE,
    body: preview,
    payload: { aboutCaseId: caseRow.id },
    error: error ?? null,
    sentAt: error ? null : new Date(),
  });
  if (!error) await ctx.tx.update(approvals).set({ channel: 'whatsapp', sentAt: new Date() }).where(eq(approvals.id, approval.id));
  return error ? { sent: false, error } : { sent: true };
}

/**
 * A note to the manager on WhatsApp: as plain text while their 24-hour window is
 * open - `justWrote`, they have just tapped a button - and as the approved
 * template when it is not, as after deciding on a call. `caseId` is the case it is about, kept on
 * the message so its cost is counted with that case.
 */
async function tellManager(ctx: Ctx, manager: ManagerRow, body: string, caseId?: string, justWrote = false) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [lastWord] = await ctx.tx
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.tenantId, ctx.tenantId), eq(messages.waId, manager.mobileE164), eq(messages.direction, 'inbound'), gte(messages.createdAt, since)))
    .limit(1);
  const message: Outbound = justWrote || lastWord
    ? { kind: 'text', to: manager.mobileE164, body }
    : {
        kind: 'template',
        to: manager.mobileE164,
        templateName: NOTED_TEMPLATE,
        language: 'en',
        variables: [body],
        preview: notedBody(body),
      };
  let providerMessageId: string | null = null;
  let status: 'sent' | 'simulated' | 'failed' = 'sent';
  try {
    const result = await ctx.channel.send(message);
    providerMessageId = result.providerMessageId;
    if (result.simulated) status = 'simulated';
  } catch {
    status = 'failed';
  }
  await ctx.tx.insert(messages).values({
    tenantId: ctx.tenantId,
    direction: 'outbound',
    channel: 'whatsapp',
    kind: message.kind === 'template' ? 'template' : 'text',
    status,
    providerMessageId,
    waId: manager.mobileE164,
    templateName: message.kind === 'template' ? NOTED_TEMPLATE : null,
    body: message.kind === 'template' ? notedBody(body) : body,
    payload: caseId ? { aboutCaseId: caseId } : undefined,
    sentAt: new Date(),
  });
}

/**
 * The manager tapped Approved or Rejected. Only the manager the request went to
 * can decide it, and only once.
 *
 * Approved: with the agent asked to apply it, it is applied in the HRMS now;
 * otherwise the manager has already approved it in their own system, and the
 * case is done. Rejected: the employee is told, and the case is closed.
 */
export async function decideApproval(
  ctx: Ctx,
  approvalId: string,
  decision: 'approve' | 'reject',
  fromMobile: string,
  via: 'whatsapp' | 'call' = 'whatsapp',
): Promise<{ handled: boolean; reason?: string }> {
  const approval = await ctx.tx.query.approvals.findFirst({ where: and(eq(approvals.id, approvalId), eq(approvals.tenantId, ctx.tenantId)) });
  if (!approval?.approverManagerId) return { handled: false, reason: 'unknown_approval' };
  const manager = await ctx.tx.query.managers.findFirst({ where: eq(managers.id, approval.approverManagerId) });
  if (!manager || manager.mobileE164 !== fromMobile) return { handled: false, reason: 'not_the_approver' };
  const action = await ctx.tx.query.actions.findFirst({ where: eq(actions.id, approval.actionId) });
  const caseRow = action?.caseId ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, action.caseId) }) : null;
  const employee = action ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, action.employeeId) }) : null;
  if (!action || !caseRow || !employee) return { handled: false, reason: 'missing_case' };

  const inputs = action.inputs as { what: string; stage: ApplicationStage; leaveType?: string };
  const date = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const who = firstName(manager.fullName);
  const what = inputs.leaveType && inputs.what === 'leave' ? inputs.leaveType : inputs.what;

  if (approval.decision !== 'pending') {
    if (via === 'whatsapp') await tellManager(ctx, manager, `This request for ${employee.fullName} on ${date} was already ${approval.decision}.`, caseRow.id, true);
    return { handled: true, reason: 'already_decided' };
  }

  const at = new Date();
  await ctx.tx
    .update(approvals)
    .set({ decision: decision === 'approve' ? 'approved' : 'rejected', respondedAt: at })
    .where(eq(approvals.id, approval.id));

  if (decision === 'reject') {
    await ctx.tx.update(actions).set({ status: 'rejected', updatedAt: at }).where(eq(actions.id, action.id));
    await ctx.tx
      .update(cases)
      .set({ status: 'resolved', resolvedAt: at, closeReason: `Not approved by ${manager.fullName}`, updatedAt: at })
      .where(eq(cases.id, caseRow.id));
    await tellEmployee(ctx, caseRow, employee);
    await tellManager(ctx, manager, `Noted - not approved. ${employee.fullName} has been told on WhatsApp.`, caseRow.id, via === 'whatsapp');
    return { handled: true };
  }

  // The agent was asked to apply it: it does so now, and says so to the employee.
  if (inputs.stage === 'apply_for_me' && action.connector && ctx.hrms) {
    await ctx.tx.update(actions).set({ status: 'approved', updatedAt: at }).where(eq(actions.id, action.id));
    const approver = manager.employeeId ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, manager.employeeId) }) : undefined;
    const result = await executeAction({ ...ctx, hrms: ctx.hrms }, { ...action, status: 'approved' }, caseRow, employee, approver ?? undefined, {
      chain: false,
      notify: false,
    });
    await tellEmployee(ctx, caseRow, employee);
    await tellManager(
      ctx,
      manager,
      result.ok
        ? `Approved. ${employee.fullName}'s ${what} for ${date} has been applied in the HRMS, and they have been told on WhatsApp.`
        : `Approved. It could not be applied automatically, so HR will finish it. ${employee.fullName} has been told on WhatsApp.`,
      caseRow.id,
      via === 'whatsapp',
    );
    return { handled: true };
  }

  await ctx.tx.update(actions).set({ status: 'approved', updatedAt: at }).where(eq(actions.id, action.id));
  await ctx.tx
    .update(cases)
    .set({ status: 'resolved', resolvedAt: at, closeReason: `Approved by ${manager.fullName}`, updatedAt: at })
    .where(eq(cases.id, caseRow.id));
  await tellEmployee(ctx, caseRow, employee);
  await tellManager(ctx, manager, `Noted - approved. ${employee.fullName} has been told on WhatsApp.`, caseRow.id, via === 'whatsapp');
  return { handled: true };
}

/**
 * Tells the employee what their manager decided - always on WhatsApp, whatever
 * they are contacted by, so the decision is there in writing to come back to.
 */
async function tellEmployee(ctx: Ctx, caseRow: CaseRow, _employee: EmployeeRow) {
  await tellEmployeeOnWhatsApp(ctx, caseRow.id);
}

/**
 * The decision on WhatsApp: as a plain message while the employee's 24-hour
 * window is open, and as the approved template once it has closed - a manager
 * answering days later would otherwise be a message WhatsApp refuses to carry.
 */
export async function tellEmployeeOnWhatsApp(ctx: Ctx, caseId: string) {
  const told = await decisionSentence(ctx as VoiceContext, caseId, false);
  if (!told) return;
  const { sentence, employee, caseRow } = told;
  if (canSend(ctx, employee).blocked) return;
  const conversation = await getConversation(ctx, employee.id);
  if (windowOpen(conversation)) {
    await sendPlainText(ctx, employee, sentence, caseRow.id);
    return;
  }
  const inputs = (await ctx.tx.query.actions.findFirst({ where: eq(actions.caseId, caseRow.id), orderBy: desc(actions.updatedAt) }))?.inputs as
    | { what?: string; leaveType?: string }
    | undefined;
  const what = inputs?.leaveType && inputs.what === 'leave' ? inputs.leaveType : inputs?.what ?? 'request';
  const date = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  // The sentence again, without the "your … for …" the template already says.
  const decided = sentence.replace(` your ${what} for ${date}`, ' it');
  const preview = `Hi ${firstName(employee.fullName)}, an update on your ${what} for ${date}: ${decided}\n\nReply here if you have any questions.`;
  await deliver(
    ctx,
    employee,
    { kind: 'template', to: employee.mobileE164!, templateName: OUTCOME_TEMPLATE, language: 'en', variables: [firstName(employee.fullName), what, date, decided], preview },
    { caseId: caseRow.id, kind: 'template', body: preview, templateName: OUTCOME_TEMPLATE },
  );
}

/**
 * A manager writing instead of tapping. With one request waiting on them, "ok",
 * "approved" or "done" approves it and "no" or "rejected" rejects it; anything
 * else, or several waiting, gets a pointer to the buttons.
 *
 * `clearOnly` is for a manager who is also an employee: what they write is only
 * taken as a decision when it plainly is one, and anything else is left to be
 * read as their own message.
 */
export async function typedManagerReply(ctx: Ctx, fromMobile: string, text: string, clearOnly = false): Promise<boolean> {
  const manager = await ctx.tx.query.managers.findFirst({ where: and(eq(managers.tenantId, ctx.tenantId), eq(managers.mobileE164, fromMobile)) });
  if (!manager) return false;
  const waiting = await ctx.tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.approverManagerId, manager.id), eq(approvals.decision, 'pending'), sql`${approvals.sentAt} is not null`));
  if (!waiting.length) return false;
  const said = text.trim().toLowerCase();
  const verdict = /\b(reject|rejected|not approved|decline|no)\b/.test(said)
    ? 'reject'
    : /\b(approve|approved|ok|okay|done|yes|haan|ha)\b/.test(said)
      ? 'approve'
      : null;
  if (waiting.length === 1 && verdict) {
    await decideApproval(ctx, waiting[0]!.id, verdict, fromMobile);
    return true;
  }
  if (clearOnly) return false;
  await tellManager(
    ctx,
    manager,
    waiting.length === 1
      ? 'Please tap Approved or Rejected on the request above.'
      : `You have ${waiting.length} requests waiting. Please tap Approved or Rejected on each one.`,
    undefined,
    true,
  );
  return true;
}

/* ------------------------------------------------------------------ *
 * The Managers page
 * ------------------------------------------------------------------ */

/**
 * Brings the managers table up to date with the employees: every distinct
 * manager the file names, by mobile or by code, gets a row. A manager nobody
 * reports to any more stays, so a request already sent can still be decided.
 */
export async function syncManagers(tx: Db, tenantId: string): Promise<void> {
  const people = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), isNull(employees.deletedAt)));
  // One lookup per distinct manager, not per employee.
  const seen = new Set<string>();
  for (const person of people) {
    const key = person.managerMobileE164 || person.managerEmployeeId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await managerFor(tx, tenantId, person);
  }
}

export type ManagerListRow = ManagerRow & {
  employeeCode: string | null;
  reports: number;
  waiting: number;
  unsent: number;
};

/** Every manager, with how many report to them and how many requests are waiting on them. */
export async function listManagers(tx: Db, tenantId: string): Promise<ManagerListRow[]> {
  await syncManagers(tx, tenantId);
  const rows = await tx.select().from(managers).where(eq(managers.tenantId, tenantId)).orderBy(managers.fullName);
  const people = await tx
    .select({ id: employees.id, empCode: employees.empCode, mobile: employees.mobileE164, managerMobile: employees.managerMobileE164, managerId: employees.managerEmployeeId })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), isNull(employees.deletedAt)));
  const byId = new Map(people.map((p) => [p.id, p]));
  const pending = await tx
    .select({ managerId: approvals.approverManagerId, sentAt: approvals.sentAt })
    .from(approvals)
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.decision, 'pending')));

  return rows.map((row) => {
    // Somebody reports to this manager if the file gives their number, or their code with this number.
    const reports = people.filter((p) => (p.managerMobile || (p.managerId ? byId.get(p.managerId)?.mobile : null)) === row.mobileE164).length;
    const mine = pending.filter((a) => a.managerId === row.id);
    return {
      ...row,
      employeeCode: row.employeeId ? byId.get(row.employeeId)?.empCode ?? null : null,
      reports,
      waiting: mine.length,
      unsent: mine.filter((a) => !a.sentAt).length,
    };
  });
}

/** The requests waiting on managers, newest first, for the Managers page. */
export async function waitingApprovals(tx: Db, tenantId: string) {
  return tx
    .select({
      id: approvals.id,
      requestedAt: approvals.requestedAt,
      sentAt: approvals.sentAt,
      managerName: managers.fullName,
      managerId: managers.id,
      employeeName: employees.fullName,
      employeeCode: employees.empCode,
      caseId: actions.caseId,
      inputs: actions.inputs,
      attDate: cases.attDate,
      meaning: cases.meaning,
    })
    .from(approvals)
    .innerJoin(actions, eq(actions.id, approvals.actionId))
    .innerJoin(employees, eq(employees.id, actions.employeeId))
    .innerJoin(managers, eq(managers.id, approvals.approverManagerId))
    .leftJoin(cases, eq(cases.id, actions.caseId))
    .where(and(eq(approvals.tenantId, tenantId), eq(approvals.decision, 'pending')))
    .orderBy(sql`${approvals.requestedAt} desc`)
    .limit(200);
}
