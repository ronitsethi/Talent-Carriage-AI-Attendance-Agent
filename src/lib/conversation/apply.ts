import type { HrmsConnector } from '@/lib/hrms/types';
import { applicationReply, requestManagerApproval } from '@/lib/approvals';
import type { CaseRow, EmployeeRow, EngineContext } from './engine';
import { instructionFor, OUTCOMES, type ApplicationStage, type LeaveChoice, type OutcomeCode } from './outcomes';

/**
 * The step after "what happened", for everything that is applied for: leave,
 * regularisation, On-Duty, comp-off.
 *
 * With attendance from a file, the employee says whether they have applied it
 * yet. If they have, their manager is asked to approve it; if not, they are told
 * to, and the follow-ups chase them until it is done or the manager takes over.
 * With an HRMS connected, the agent offers to apply it itself, and the manager's
 * approval is what sets it going.
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

/**
 * "I was on leave, not applied yet" is what a model falls back on when someone
 * only says they were on leave - a guess, so until they say where it stands it
 * is asked, as the buttons ask it. "Already applied" is never a guess: they
 * said it, and it goes straight on.
 */
export const isOnLeave = (code: OutcomeCode) => code === 'leave_not_applied';

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
    /** Other dates answered together with this one, decided by the same request. */
    alsoCases?: CaseRow[];
  },
): Promise<string> {
  // Without an HRMS to write to, "apply it for me" is the employee applying it after all.
  const stage: ApplicationStage = request.stage === 'apply_for_me' && !agentCanApply(ctx) ? 'not_applied' : request.stage;
  // Nothing to approve yet: the case stays with the employee and its follow-ups run.
  if (stage === 'not_applied') return instructionFor(request.code, request.choice, request.facts);
  const result = await requestManagerApproval(ctx, caseRow, employee, { ...request, stage });
  const manager = result.manager ? result.manager.fullName.split(/\s+/)[0] ?? null : null;
  return applicationReply({ ...request, stage }, { ...request.facts, manager: manager ?? request.facts.manager }, result.managerReached);
}
