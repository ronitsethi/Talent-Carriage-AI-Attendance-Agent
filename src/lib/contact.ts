import { eq } from 'drizzle-orm';
import { cases, employees } from '@/db/schema';
import { askCase, type CaseRow, type EmployeeRow } from '@/lib/conversation/engine';
import { placeCaseCall } from '@/lib/voice/session';
import type { FullContext } from '@/lib/runtime';

/**
 * Contacts an employee about one date, on whichever channel they are set to.
 *
 * This is the only place that knows a case can be a message or a call. The flow
 * either side of it - what is asked, what the answer means, how the backlog is
 * swept - is identical.
 */
export type ContactResult =
  | { contacted: true; channel: 'whatsapp' | 'voice'; simulated?: boolean }
  | { contacted: false; channel: 'whatsapp' | 'voice'; reason: string };

export function channelFor(employee: EmployeeRow, fallback: string): 'whatsapp' | 'voice' {
  const choice = employee.preferredChannel || fallback;
  return choice === 'voice' ? 'voice' : 'whatsapp';
}

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

  if (channel === 'voice') {
    const result = await placeCaseCall(ctx, caseRow, employee);
    return result.placed
      ? { contacted: true, channel, simulated: result.simulated }
      : { contacted: false, channel, reason: result.reason };
  }

  const result = await askCase(ctx, caseRow, employee);
  return result.sent
    ? { contacted: true, channel, simulated: result.simulated }
    : { contacted: false, channel, reason: result.reason };
}

/** Looks up the employee and contacts them, for callers that only hold a case. */
export async function contactCaseById(ctx: FullContext, caseId: string): Promise<ContactResult | null> {
  const caseRow = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId) });
  if (!caseRow) return null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
  if (!employee) return null;
  return contactCase(ctx, caseRow, employee);
}
