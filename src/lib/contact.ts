import { eq } from 'drizzle-orm';
import { cases, employees } from '@/db/schema';
import { askCase, type CaseRow, type EmployeeRow } from '@/lib/conversation/engine';
import { channelFor } from '@/lib/channel';
import { callPurposeFor, placeCaseCall, type CallPurpose } from '@/lib/voice/session';
import { sendFollowUpMessage } from '@/lib/conversation/followup';
import type { FullContext } from '@/lib/runtime';

export { channelFor };

/**
 * Contacts an employee about one date, on whichever channel they are set to.
 *
 * This is the only place that knows a case can be a message or a call. The flow
 * either side of it - what is asked, what the answer means, how the backlog is
 * swept - is identical.
 */
export type ContactResult =
  | { contacted: true; channel: 'whatsapp' | 'voice'; purpose: CallPurpose; simulated?: boolean }
  | { contacted: false; channel: 'whatsapp' | 'voice'; purpose: CallPurpose; reason: string };

export async function contactCase(
  ctx: FullContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
): Promise<ContactResult> {
  const channel = channelFor(employee, ctx.settings.defaultChannel);

  // Record the channel on the case, so history shows how someone was reached
  // even if their preference changes later.
  if (caseRow.channel !== channel) {
    await ctx.tx.update(cases).set({ channel, updatedAt: new Date() }).where(eq(cases.id, caseRow.id));
    caseRow = { ...caseRow, channel };
  }

  // A date that has already been answered is past its first question. Contacting
  // that person again means the day-2 reminder - "have you applied the leave
  // yet?" - not the same question a second time.
  const purpose = callPurposeFor(caseRow);

  if (channel === 'voice') {
    const result = await placeCaseCall(ctx, caseRow, employee, purpose);
    return result.placed
      ? { contacted: true, channel, purpose, simulated: result.simulated }
      : { contacted: false, channel, purpose, reason: result.reason };
  }

  if (purpose === 'follow_up') {
    await sendFollowUpMessage(ctx, caseRow, employee);
    return { contacted: true, channel, purpose };
  }

  const result = await askCase(ctx, caseRow, employee);
  return result.sent
    ? { contacted: true, channel, purpose, simulated: result.simulated }
    : { contacted: false, channel, purpose, reason: result.reason };
}

/** Looks up the employee and contacts them, for callers that only hold a case. */
export async function contactCaseById(ctx: FullContext, caseId: string): Promise<ContactResult | null> {
  const caseRow = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId) });
  if (!caseRow) return null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
  if (!employee) return null;
  return contactCase(ctx, caseRow, employee);
}
