import { and, eq } from 'drizzle-orm';
import { actions, approvals, cases, employees, leaveBalances, usageEvents } from '@/db/schema';
import type { PreCheckResult } from '@/db/schema/actions';
import type { HrmsConnector } from '@/lib/hrms/types';
import type { Meaning } from '@/lib/mapping/meanings';
import { halfOfDay } from '@/lib/mapping/meanings';
import {
  actionApprovedMessage,
  actionFailedMessage,
  actionLabels,
  actionRejectedMessage,
  actionSubmittedMessage,
  approvalSelectionId,
  dateLabel,
  managerDecisionAck,
  managerMessages,
  offerDeclinedMessage,
  offerLeaveMessage,
  offerRegularisationMessage,
  offerSelectionId,
  preCheckFailedMessage,
  type OptionNumber,
} from '@/lib/conversation/flow';
import {
  canSend,
  chainNextPending,
  getConversation,
  sendButtons,
  sendPlainText,
  type CaseRow,
  type EmployeeRow,
  type EngineContext,
} from '@/lib/conversation/engine';

export type ActionContext = EngineContext & { hrms: HrmsConnector | null };
export type ActionRow = typeof actions.$inferSelect;

/** Which action a reply implies, before anything is checked. */
export function actionForOption(option: OptionNumber): 'apply_leave' | 'apply_regularisation' | 'nudge_manager' {
  switch (option) {
    case 1:
      return 'apply_leave';
    case 2:
      return 'apply_regularisation';
    default:
      return 'nudge_manager';
  }
}

const capabilityFor = {
  apply_leave: 'apply_leave',
  apply_regularisation: 'apply_regularisation',
} as const;

/**
 * Offers to do the work, once the employee has said what happened.
 *
 * Nothing is submitted here. The offer exists so the employee explicitly asks -
 * the action engine never acts on an inferred wish, and an ignored offer simply
 * leaves the case as guidance.
 *
 * Returns true when an offer was made, in which case the backlog chain waits
 * until the offer is resolved rather than talking over it.
 */
export async function offerAction(
  ctx: ActionContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  option: OptionNumber,
): Promise<boolean> {
  if (!ctx.settings.actionsEnabled) return false;
  const type = actionForOption(option);
  if (type === 'nudge_manager') return false; // options 3 and 4 are chased at the manager, later

  const allowed = ctx.settings.allowedActions ?? [];
  if (allowed.length && !allowed.includes(type)) return false;
  if (!ctx.hrms?.supports(capabilityFor[type])) return false;
  if (canSend(ctx, employee).blocked) return false;

  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);

  if (type === 'apply_leave') {
    const chosen = await pickLeaveType(ctx, employee);
    if (!chosen) {
      // No balance anywhere: say so plainly rather than offering something that
      // would be rejected, and leave the guidance already sent standing.
      await sendPlainText(ctx, employee, preCheckFailedMessage('you have no leave balance available'), caseRow.id);
      return false;
    }
    await sendButtons(
      ctx,
      employee,
      offerLeaveMessage(label, chosen.label, chosen.balanceDays),
      [
        { id: offerSelectionId(caseRow.id, 'accept'), title: 'Yes, apply it' },
        { id: offerSelectionId(caseRow.id, 'self'), title: "I'll do it myself" },
      ],
      caseRow.id,
    );
    await rememberOffer(ctx, caseRow, { type, leaveType: chosen.leaveType });
    return true;
  }

  await sendButtons(
    ctx,
    employee,
    offerRegularisationMessage(label),
    [
      { id: offerSelectionId(caseRow.id, 'accept'), title: 'Yes, apply it' },
      { id: offerSelectionId(caseRow.id, 'self'), title: "I'll do it myself" },
    ],
    caseRow.id,
  );
  await rememberOffer(ctx, caseRow, { type });
  return true;
}

async function rememberOffer(ctx: ActionContext, caseRow: CaseRow, offer: Record<string, unknown>) {
  await ctx.tx
    .update(cases)
    .set({
      status: 'awaiting_action',
      context: { ...(caseRow.context as object), offer },
      updatedAt: new Date(),
    })
    .where(eq(cases.id, caseRow.id));
}

/** The leave type with the most balance, preferring casual then sick then earned. */
async function pickLeaveType(ctx: ActionContext, employee: EmployeeRow) {
  const allowed = ctx.settings.allowedLeaveTypes ?? [];
  const response = await ctx.hrms!.fetchLeaveBalance(employee.empCode);
  if (!response.ok) return null;

  // Keep our copy fresh, so the agent can answer "how many leaves do I have?".
  for (const balance of response.data) {
    await ctx.tx
      .insert(leaveBalances)
      .values({
        tenantId: ctx.tenantId,
        employeeId: employee.id,
        leaveType: balance.leaveType,
        balanceDays: Math.floor(balance.balanceDays),
      })
      .onConflictDoUpdate({
        target: [leaveBalances.employeeId, leaveBalances.leaveType],
        set: { balanceDays: Math.floor(balance.balanceDays), asOf: new Date() },
      });
  }

  const order = ['CL', 'SL', 'EL'];
  const candidates = response.data
    .filter((b) => b.balanceDays >= 0.5 && b.leaveType !== 'LWP')
    .filter((b) => !allowed.length || allowed.includes(b.leaveType))
    .sort((a, b) => order.indexOf(a.leaveType) - order.indexOf(b.leaveType));
  return candidates[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * The employee's answer to the offer
 * ------------------------------------------------------------------ */

export async function handleOfferResponse(
  ctx: ActionContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  choice: 'accept' | 'self' | 'other_type',
) {
  if (choice === 'self') {
    await ctx.tx
      .update(cases)
      .set({ status: 'answered', updatedAt: new Date() })
      .where(eq(cases.id, caseRow.id));
    await sendPlainText(ctx, employee, offerDeclinedMessage(), caseRow.id);
    await chainNextPending(ctx, employee, caseRow.id);
    return { accepted: false };
  }

  const offer = (caseRow.context as { offer?: { type: string; leaveType?: string } }).offer;
  if (!offer) return { accepted: false };

  const action = await createAction(ctx, caseRow, employee, offer);
  if (!action.ok) {
    await sendPlainText(ctx, employee, preCheckFailedMessage(action.reason), caseRow.id);
    await ctx.tx
      .update(cases)
      .set({ status: 'answered', updatedAt: new Date() })
      .where(eq(cases.id, caseRow.id));
    await chainNextPending(ctx, employee, caseRow.id);
    return { accepted: false };
  }

  await requestApproval(ctx, action.row, caseRow, employee);
  return { accepted: true, actionId: action.row.id };
}

/**
 * Creates the action record, after running the checks the HRMS would run.
 *
 * Checking first means the employee hears "you have no balance left" in plain
 * language now, rather than a failure surfacing after their manager has already
 * approved it.
 */
async function createAction(
  ctx: ActionContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  offer: { type: string; leaveType?: string },
): Promise<{ ok: true; row: ActionRow } | { ok: false; reason: string }> {
  const half = halfOfDay(caseRow.meaning as Meaning);
  const preChecks: PreCheckResult[] = [];

  if (offer.type === 'apply_leave') {
    const balances = await ctx.hrms!.fetchLeaveBalance(employee.empCode);
    if (!balances.ok) return { ok: false, reason: balances.message };
    const balance = balances.data.find((b) => b.leaveType === offer.leaveType);
    const needed = half === 'first' || half === 'second' ? 0.5 : 1;
    if (!balance || balance.balanceDays < needed) {
      return { ok: false, reason: `you do not have enough ${offer.leaveType ?? 'leave'} balance` };
    }
    preChecks.push({ name: 'balance', passed: true, detail: `${balance.balanceDays} day(s) available` });
  }

  // The key ties this request to this employee, date and intent, so a retry or a
  // double tap can never create a second request in the HRMS.
  const idempotencyKey = `${offer.type}:${employee.id}:${caseRow.attDate}`;

  const existing = await ctx.tx.query.actions.findFirst({
    where: and(eq(actions.tenantId, ctx.tenantId), eq(actions.idempotencyKey, idempotencyKey)),
  });
  if (existing) return { ok: true, row: existing };

  const [row] = await ctx.tx
    .insert(actions)
    .values({
      tenantId: ctx.tenantId,
      caseId: caseRow.id,
      employeeId: employee.id,
      type: offer.type as ActionRow['type'],
      status: 'awaiting_approval',
      inputs: {
        date: caseRow.attDate,
        leaveType: offer.leaveType,
        halfDay: half === 'first' || half === 'second' ? half : null,
        reason: caseRow.replyText ?? undefined,
      },
      preChecks,
      requestedVia: 'whatsapp',
      idempotencyKey,
      connector: ctx.hrms?.name,
    })
    .returning();
  return { ok: true, row: row! };
}

/* ------------------------------------------------------------------ *
 * The manager's approval
 * ------------------------------------------------------------------ */

export async function requestApproval(
  ctx: ActionContext,
  action: ActionRow,
  caseRow: CaseRow,
  employee: EmployeeRow,
) {
  const manager = employee.managerEmployeeId
    ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, employee.managerEmployeeId) })
    : null;

  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const what = actionLabels[action.type as keyof typeof actionLabels] ?? 'request';

  const [approval] = await ctx.tx
    .insert(approvals)
    .values({
      tenantId: ctx.tenantId,
      actionId: action.id,
      approverEmployeeId: manager?.id ?? null,
      channel: 'whatsapp',
      timeoutAt: new Date(Date.now() + ctx.settings.approvalTimeoutHours * 3600_000),
    })
    .returning();

  await ctx.tx
    .update(cases)
    .set({ status: 'awaiting_approval', updatedAt: new Date() })
    .where(eq(cases.id, caseRow.id));

  // No reachable manager: HR decides instead, rather than the request stalling.
  if (!manager || !manager.mobileE164 || manager.whatsappOptOut) {
    await ctx.tx
      .update(cases)
      .set({
        status: 'needs_hr',
        needsHrReason: manager ? 'Manager has no reachable number' : 'No manager mapped for this employee',
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseRow.id));
    return { approvalId: approval!.id, sentToManager: false };
  }

  await sendButtons(
    ctx,
    manager,
    managerMessages.approvalRequest(employee.fullName, what, label, action.inputs.reason as string | undefined),
    [
      { id: approvalSelectionId(approval!.id, 'approve'), title: 'Approve' },
      { id: approvalSelectionId(approval!.id, 'reject'), title: 'Reject' },
      { id: approvalSelectionId(approval!.id, 'details'), title: 'Ask for details' },
    ],
    caseRow.id,
  );

  await sendPlainText(
    ctx,
    employee,
    actionSubmittedMessage(what, label, manager.fullName.split(' ')[0] ?? null),
    caseRow.id,
  );
  return { approvalId: approval!.id, sentToManager: true };
}

/** The manager tapped Approve or Reject: record it, then carry it out. */
export async function handleApprovalDecision(
  ctx: ActionContext,
  approvalId: string,
  decision: 'approve' | 'reject' | 'details',
  approver: EmployeeRow,
) {
  const approval = await ctx.tx.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
  if (!approval) return { handled: false as const, reason: 'unknown_approval' };
  if (approval.decision !== 'pending') return { handled: false as const, reason: 'already_decided' };

  const action = await ctx.tx.query.actions.findFirst({ where: eq(actions.id, approval.actionId) });
  if (!action) return { handled: false as const, reason: 'unknown_action' };
  const caseRow = action.caseId
    ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, action.caseId) })
    : null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, action.employeeId) });
  if (!caseRow || !employee) return { handled: false as const, reason: 'missing_case' };

  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const what = actionLabels[action.type as keyof typeof actionLabels] ?? 'request';

  if (decision === 'details') {
    await sendPlainText(
      ctx,
      approver,
      `${employee.fullName} is marked absent on ${label}. Reason given: ${
        (action.inputs.reason as string) || 'not stated'
      }. Reply Approve or Reject when you are ready.`,
      caseRow.id,
    );
    return { handled: true as const, decision: 'details' as const };
  }

  await ctx.tx
    .update(approvals)
    .set({ decision: decision === 'approve' ? 'approved' : 'rejected', respondedAt: new Date() })
    .where(eq(approvals.id, approval.id));

  if (decision === 'reject') {
    await ctx.tx.update(actions).set({ status: 'rejected', updatedAt: new Date() }).where(eq(actions.id, action.id));
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: 'Manager rejected the request', updatedAt: new Date() })
      .where(eq(cases.id, caseRow.id));
    await sendPlainText(ctx, employee, actionRejectedMessage(what, label), caseRow.id);
    await sendPlainText(ctx, approver, managerDecisionAck('rejected', employee.fullName, label), caseRow.id);
    await chainNextPending(ctx, employee, caseRow.id);
    return { handled: true as const, decision: 'rejected' as const };
  }

  await ctx.tx.update(actions).set({ status: 'approved', updatedAt: new Date() }).where(eq(actions.id, action.id));
  const executed = await executeAction(ctx, { ...action, status: 'approved' }, caseRow, employee, approver);
  await sendPlainText(ctx, approver, managerDecisionAck('approved', employee.fullName, label), caseRow.id);
  return { handled: true as const, decision: 'approved' as const, executed };
}

/**
 * Carries the action out in the HRMS.
 *
 * Success means the HRMS gave us something to prove it. If it accepted the write
 * but returned nothing verifiable, the action is left `unconfirmed` and read back
 * later rather than reported to the employee as done.
 */
export async function executeAction(
  ctx: ActionContext,
  action: ActionRow,
  caseRow: CaseRow,
  employee: EmployeeRow,
  approver?: EmployeeRow,
) {
  if (!ctx.hrms) return { ok: false as const, reason: 'No HRMS connector configured' };

  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const what = actionLabels[action.type as keyof typeof actionLabels] ?? 'request';
  const inputs = action.inputs as { date: string; leaveType?: string; halfDay?: 'first' | 'second' | null; reason?: string };

  await ctx.tx
    .update(actions)
    .set({ status: 'executing', attempts: action.attempts + 1, updatedAt: new Date() })
    .where(eq(actions.id, action.id));

  const response =
    action.type === 'apply_leave'
      ? await ctx.hrms.applyLeave({
          employeeCode: employee.empCode,
          fromDate: inputs.date,
          toDate: inputs.date,
          leaveType: inputs.leaveType ?? 'CL',
          halfDay: inputs.halfDay ?? null,
          reason: inputs.reason,
          idempotencyKey: action.idempotencyKey,
        })
      : await ctx.hrms.applyRegularisation({
          employeeCode: employee.empCode,
          date: inputs.date,
          halfDay: inputs.halfDay ?? null,
          reason: inputs.reason ?? 'Attendance not recorded',
          idempotencyKey: action.idempotencyKey,
        });

  if (!response.ok) {
    await ctx.tx
      .update(actions)
      .set({ status: 'failed', lastError: response.message, updatedAt: new Date() })
      .where(eq(actions.id, action.id));
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: `Action failed: ${response.message}`, updatedAt: new Date() })
      .where(eq(cases.id, caseRow.id));
    await sendPlainText(ctx, employee, actionFailedMessage(what, label), caseRow.id);
    return { ok: false as const, reason: response.message };
  }

  const request = response.data;

  // Approve it on the employee's behalf where the HRMS lets us, since the
  // manager has already approved in WhatsApp and this keeps both in step.
  let finalStatus = request.status;
  let reference = request.reference || null;
  if (reference && approver && ctx.hrms.supports('approve_request')) {
    const approved = await ctx.hrms.approve({
      reference,
      approverCode: approver.empCode,
      decision: 'approve',
      idempotencyKey: `${action.idempotencyKey}:approve`,
    });
    if (approved.ok) finalStatus = approved.data.status;
  }

  const confirmed = Boolean(reference);
  await ctx.tx
    .update(actions)
    .set({
      status: confirmed ? 'executed' : 'unconfirmed',
      hrmsReference: reference,
      hrmsResponse: request as unknown as Record<string, unknown>,
      executedAt: new Date(),
      verifiedAt: confirmed ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(actions.id, action.id));

  await ctx.tx.insert(usageEvents).values({
    tenantId: ctx.tenantId,
    kind: 'action_executed',
    meta: { type: action.type, reference, status: finalStatus },
  });

  await ctx.tx
    .update(cases)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      closeReason: `${what} ${finalStatus} in the HRMS${reference ? ` (${reference})` : ''}`,
      updatedAt: new Date(),
    })
    .where(eq(cases.id, caseRow.id));

  await sendPlainText(ctx, employee, actionApprovedMessage(what, label, reference), caseRow.id);
  await chainNextPending(ctx, employee, caseRow.id);
  return { ok: true as const, reference, status: finalStatus };
}
