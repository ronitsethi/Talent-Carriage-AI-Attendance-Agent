import type { HrmsConnector } from '@/lib/hrms/types';
import { applicationReply, requestManagerApproval } from '@/lib/approvals';
import type { CaseRow, EmployeeRow, EngineContext } from './engine';
import { OUTCOMES, type ApplicationStage, type LeaveChoice, type OutcomeCode } from './outcomes';

/**
 * The step after "what happened", for everything that is applied for: leave,
 * regularisation, On-Duty, comp-off.
 *
 * With attendance from a file, the employee says whether they have applied it
 * yet - if not, they are told to - and their manager is asked to approve it once
 * it is in their system. With an HRMS connected, the agent offers to apply it
 * itself, and the manager's approval is what sets it going.
 */

export type ApplyContext = EngineContext & { hrms?: HrmsConnector | null };

/** Whether the agent can apply things itself: an HRMS customer, with a connector to write to. */
export function agentCanApply(ctx: ApplyContext): boolean {
  return ctx.settings.attendanceSource === 'hrms' && Boolean(ctx.hrms);
}

/** Whether this outcome, with this leave-or-Loss-of-Pay choice, ends in an application. */
export function needsApplication(code: OutcomeCode, choice: LeaveChoice | null): boolean {
  const outcome = OUTCOMES[code];
  if (!outcome.application) return false;
  return !outcome.asksLeaveOrLossOfPay || choice === 'leave';
}

/** The leave types the agent can apply, with what is left of each, from the HRMS. */
export async function leaveTypesFor(ctx: ApplyContext, employee: EmployeeRow): Promise<{ type: string; days: number }[]> {
  if (!ctx.hrms) return [];
  const response = await ctx.hrms.fetchLeaveBalance(employee.empCode);
  if (!response.ok) return [];
  const allowed = ctx.settings.allowedLeaveTypes ?? [];
  return response.data
    .filter((b) => b.balanceDays >= 0.5 && b.leaveType !== 'LWP')
    .filter((b) => !allowed.length || allowed.includes(b.leaveType))
    .map((b) => ({ type: b.leaveType, days: b.balanceDays }));
}

/**
 * Asks the manager to approve it, and returns what the employee is told. The
 * outcome itself must already be recorded; this is the request that follows.
 */
export async function submitApplication(
  ctx: ApplyContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  request: {
    code: OutcomeCode;
    choice: LeaveChoice | null;
    stage: ApplicationStage;
    leaveType?: string | null;
    note: string | null;
    via: 'whatsapp' | 'call';
    facts: { date: string; deadline: string; manager: string | null };
  },
): Promise<string> {
  // Without an HRMS to write to, "apply it for me" is the employee applying it after all.
  const stage: ApplicationStage = request.stage === 'apply_for_me' && !agentCanApply(ctx) ? 'not_applied' : request.stage;
  const result = await requestManagerApproval(ctx, caseRow, employee, { ...request, stage });
  const manager = result.manager ? result.manager.fullName.split(/\s+/)[0] ?? null : null;
  return applicationReply({ ...request, stage }, { ...request.facts, manager: manager ?? request.facts.manager }, result.managerReached);
}
