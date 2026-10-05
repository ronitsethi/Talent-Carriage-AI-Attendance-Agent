import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { approvals, actions, cases, employees, tenants, tenantSettings } from '@/db/schema';
import { sendDueFollowUps } from '@/lib/conversation/followup';
import { closeCasesExplainedByData, runDailyCheckAndContact } from '@/lib/detection/run';
import { buildContext } from '@/lib/runtime';
import { sendPlainText } from '@/lib/conversation/engine';
import type { Job, JobKind } from './queue';

export type JobHandler = (job: Job) => Promise<Record<string, unknown>>;

/** The daily check for one tenant and date. */
const dailyCheck: JobHandler = async (job) => {
  const { date, trigger } = job.payload as { date: string; trigger?: 'schedule' | 'manual' | 'catch_up' };
  const tenantId = job.tenantId!;
  await withTenant(tenantId, (tx) => closeCasesExplainedByData(tx, tenantId, date));
  const result = await runDailyCheckAndContact(tenantId, { date, trigger: trigger ?? 'schedule' });
  return result as unknown as Record<string, unknown>;
};

/** Day-2 reminders for every case whose clock has run out. */
const sendFollowUp: JobHandler = async (job) => {
  const tenantId = job.tenantId!;
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    return (await sendDueFollowUps(ctx)) as unknown as Record<string, unknown>;
  });
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
        and(eq(approvals.tenantId, tenantId), eq(approvals.decision, 'pending'), lte(approvals.timeoutAt, new Date())),
      )
      .limit(100);

    let escalated = 0;
    for (const approval of expired) {
      await tx
        .update(approvals)
        .set({ decision: 'expired', escalatedTo: ctx.settings.approvalEscalatesTo })
        .where(eq(approvals.id, approval.id));
      const action = await tx.query.actions.findFirst({ where: eq(actions.id, approval.actionId) });
      if (action?.caseId) {
        await tx
          .update(cases)
          .set({
            status: 'needs_hr',
            needsHrReason: `Manager did not respond within ${ctx.settings.approvalTimeoutHours} hours`,
            updatedAt: new Date(),
          })
          .where(eq(cases.id, action.caseId));
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
      .where(eq(employees.tenantId, tenantId))
      .limit(500);
    let refreshed = 0;
    for (const person of people) {
      const response = await ctx.hrms.fetchLeaveBalance(person.empCode);
      if (response.ok) refreshed++;
    }
    return { refreshed };
  });
};

/** Placed here so the queue is complete; the voice provider arrives in its phase. */
const placeCall: JobHandler = async (job) => {
  return { skipped: 'voice provider not configured', caseId: job.payload.caseId };
};

export const handlers: Record<JobKind, JobHandler> = {
  daily_check: dailyCheck,
  send_follow_up: sendFollowUp,
  approval_timeout: approvalTimeout,
  verify_action: verifyAction,
  refresh_leave_balances: refreshLeaveBalances,
  place_call: placeCall,
  import_file: async () => ({ skipped: 'handled by the upload route for now' }),
};
