import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { runAbsenceWatch } from '@/lib/conversation/absence-reminders';
import { withPlatformScope, withTenant } from '@/db';
import { approvals, actions, cases, employees, tenants, tenantSettings } from '@/db/schema';
import { contactAfterUpload, type SendStage } from '@/lib/upload-send';
import { buildContext } from '@/lib/runtime';
import { sendPlainText } from '@/lib/conversation/engine';
import { sendQueryFeedback } from '@/lib/conversation/feedback';
import { queueTicketCheck, raiseTicket } from '@/lib/tickets';
import { escalateToLt, informCoe, notifyAssignee, remindAssignee } from '@/lib/ticket-whatsapp';
import { tellEmployeeAboutTicket, type TicketEvent } from '@/lib/conversation/ticket-notices';
import { Postpone, type Job, type JobKind } from './queue';
import { contactCaseById } from '@/lib/contact';
import { sendDueFollowUps, sendFollowUpsAfterUpload } from '@/lib/conversation/followup';
import { sendApprovalRequest } from '@/lib/approvals';
import type { WaitingCall } from '@/lib/voice/waiting';
import { applyPlivoCharge, type ChargeLookup } from '@/lib/costs/plivo';

export type JobHandler = (job: Job) => Promise<Record<string, unknown>>;

/** One person's turn in a send after an attendance upload. */
const uploadContact: JobHandler = async (job) => {
  const { employeeId, stage } = job.payload as { employeeId: string; stage: SendStage };
  return contactAfterUpload(job.tenantId!, employeeId, stage);
};

/**
 * An approval nobody answered. Rather than leaving the employee waiting, the
 * case goes to whoever the tenant nominated - HR by default.
 */
const approvalTimeout: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    const expired = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.tenantId, tenantId),
          eq(approvals.decision, 'pending'),
          lte(approvals.timeoutAt, new Date()),
          // A locked month's request waits with its case; unlocking gives it back the time it had left.
          sql`not exists (select 1 from actions a join cases c on c.id = a.case_id where a.id = ${approvals.actionId} and c.status = 'unresolved')`,
        ),
      )
      .limit(100);

    let escalated = 0;
    for (const approval of expired) {
      await tx
        .update(approvals)
        .set({ decision: 'expired', escalatedTo: ctx.settings.approvalEscalatesTo })
        .where(eq(approvals.id, approval.id));
      // Every date the request decided goes to HR, not only the one it was asked from.
      const decided = await tx
        .select({ caseId: actions.caseId })
        .from(actions)
        .where(inArray(actions.id, [approval.actionId, ...(approval.covers ?? [])]));
      const caseIds = decided.map((row) => row.caseId).filter((id): id is string => Boolean(id));
      if (caseIds.length) {
        await tx
          .update(cases)
          .set({
            status: 'needs_hr',
            needsHrReason: `Manager did not respond within ${ctx.settings.approvalTimeoutHours} hours`,
            updatedAt: new Date(),
          })
          .where(inArray(cases.id, caseIds));
      }
      escalated++;
    }
    return { escalated };
  });
};

/**
 * Reads back actions the HRMS accepted without returning anything verifiable,
 * so "unconfirmed" either becomes proven or becomes HR's problem.
 */
const verifyAction: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (!ctx.hrms?.supports('read_request_status')) return { skipped: 'connector cannot read status' };

    const pending = await tx
      .select()
      .from(actions)
      .where(and(eq(actions.tenantId, tenantId), eq(actions.status, 'unconfirmed')))
      .limit(50);

    let verified = 0;
    for (const action of pending) {
      if (!action.hrmsReference) continue;
      const response = await ctx.hrms.readRequest(action.hrmsReference);
      if (response.ok) {
        await tx
          .update(actions)
          .set({ status: 'executed', verifiedAt: new Date(), updatedAt: new Date() })
          .where(eq(actions.id, action.id));
        verified++;
      }
    }
    return { checked: pending.length, verified };
  });
};

/** Keeps our copy of leave balances fresh, so policy answers stay truthful. */
const refreshLeaveBalances: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (!ctx.hrms?.supports('fetch_leave_balance')) return { skipped: true };
    const people = await tx
      .select({ empCode: employees.empCode })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), isNull(employees.deletedAt)))
      .limit(500);
    let refreshed = 0;
    for (const person of people) {
      const response = await ctx.hrms.fetchLeaveBalance(person.empCode);
      if (response.ok) refreshed++;
    }
    return { refreshed };
  });
};

/** Asks for feedback on a call somebody made to us, a minute after it ended. */
const queryFeedback: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  const queryId = String(job.payload.queryId ?? '');
  return withTenant(tenantId, async (tx) => sendQueryFeedback(await buildContext(tx, tenantId), queryId));
};

/**
 * Raises a query's ticket once its conversation is over, if anything is left
 * for a person to do. A chat that has moved on since is looked at again later.
 */
const queryTicket: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  const queryId = String(job.payload.queryId ?? '');
  const outcome = await raiseTicket(queryId);
  if (outcome.done === 'later') await withTenant(tenantId, (tx) => queueTicketCheck(tx, tenantId, queryId, outcome.at, true));
  return outcome as unknown as Record<string, unknown>;
};

/** A ticket's WhatsApp message to whoever it was just given to. */
const ticketNotify: JobHandler = async (job) => {
  const { queryId, assignedAt } = job.payload as { queryId: string; assignedAt?: string };
  return (await notifyAssignee(queryId, assignedAt)) as Record<string, unknown>;
};

/** At 36 hours: the warning that it moves to the LT person in 12. */
const ticketReminder: JobHandler = async (job) => {
  const { queryId, assignedAt } = job.payload as { queryId: string; assignedAt: string };
  return (await remindAssignee(queryId, assignedAt)) as Record<string, unknown>;
};

/** At 48 hours: the move to the LT person. */
const ticketEscalate: JobHandler = async (job) => {
  const { queryId, assignedAt } = job.payload as { queryId: string; assignedAt: string };
  return (await escalateToLt(queryId, assignedAt)) as Record<string, unknown>;
};

/** A query that needed no ticket, shared with its COE team for their information. */
const queryInform: JobHandler = async (job) => {
  const { queryId } = job.payload as { queryId: string };
  return (await informCoe(queryId)) as Record<string, unknown>;
};

/** The employee's WhatsApp about their ticket: its number when raised, and when it is resolved. */
const ticketEmployee: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  const { queryId, event } = job.payload as { queryId: string; event: TicketEvent };
  return withTenant(tenantId, async (tx) => tellEmployeeAboutTicket(await buildContext(tx, tenantId), queryId, event));
};

/**
 * A call that found every line busy. Tried again, without queueing a second
 * wait, and put back for 15 seconds while every line is still busy.
 */
const waitingCall: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  const call = job.payload as unknown as WaitingCall;
  const outcome = await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (call.action === 'contact_case') {
      const result = await contactCaseById(ctx, call.caseId, { queueIfBusy: false });
      return { busy: Boolean(result && !result.contacted && result.busy), result };
    }
    if (call.action === 'follow_ups') {
      const result =
        call.mode === 'upload'
          ? await sendFollowUpsAfterUpload(ctx, call.employeeId, new Date(), false)
          : await sendDueFollowUps(ctx, new Date(), call.employeeId, false);
      return { busy: result.busy, result };
    }
    const result = await sendApprovalRequest(ctx, call.approvalId, undefined, false);
    return { busy: Boolean(result.busy), result };
  });
  if (outcome.busy) throw new Postpone(15);
  return outcome as unknown as Record<string, unknown>;
};

/** Placed here so the queue is complete; the voice provider arrives in its phase. */
const placeCall: JobHandler = async (job) => {
  return { skipped: 'voice provider not configured', caseId: job.payload.caseId };
};

/** One person's unanswered absences: a reminder, or the manager, when due. */
const absenceWatch: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  const employeeId = String(job.payload.employeeId ?? '');
  return withTenant(tenantId, async (tx) => runAbsenceWatch(await buildContext(tx, tenantId), employeeId));
};

export const handlers: Record<JobKind, JobHandler> = {
  upload_contact: uploadContact,
  absence_watch: absenceWatch,
  approval_timeout: approvalTimeout,
  verify_action: verifyAction,
  refresh_leave_balances: refreshLeaveBalances,
  place_call: placeCall,
  import_file: async () => ({ skipped: 'handled by the upload route for now' }),
  query_feedback: queryFeedback,
  query_ticket: queryTicket,
  ticket_notify: ticketNotify,
  ticket_reminder: ticketReminder,
  ticket_escalate: ticketEscalate,
  query_inform: queryInform,
  ticket_employee: ticketEmployee,
  waiting_call: waitingCall,
  // Plivo's own charge for a talking call, or a keypad call to us, once its record is in.
  plivo_charge: async (job) => applyPlivoCharge(job.payload as unknown as ChargeLookup),
};
