import { eq } from 'drizzle-orm';
import { cases, employees } from '@/db/schema';
import { askCase, type CaseRow, type EmployeeRow } from '@/lib/conversation/engine';
import { channelFor, followUpChannel } from '@/lib/channel';
import { callPurposeFor, placeCaseCall, type CallPurpose } from '@/lib/voice/session';
import { nextFollowUp, sendFollowUp } from '@/lib/conversation/followup';
import { isLocked, LOCKED_REASON } from '@/lib/locks';
import { waitForLine } from '@/lib/voice/waiting';
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
  | { contacted: true; channel: 'whatsapp' | 'voice'; purpose: CallPurpose; simulated?: boolean; waiting?: false }
  /** A call with every line busy: queued to ring the moment one is free. */
  | { contacted: true; channel: 'voice'; purpose: CallPurpose; waiting: true }
  /** With `busy`, `queueIfBusy` was off: every line was busy and nothing was queued. */
  | { contacted: false; channel: 'whatsapp' | 'voice'; purpose: CallPurpose; reason: string; busy?: boolean };

export type ContactOptions = {
  /** When every call line is busy, queue the call to wait for one (the default), or just report it. */
  queueIfBusy?: boolean;
};

export async function contactCase(
  ctx: FullContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  opts: ContactOptions = {},
): Promise<ContactResult> {
  // A locked month's attendance is final: nobody is contacted about it, however asked.
  if (caseRow.status === 'unresolved' || (await isLocked(ctx.tx, ctx.tenantId, caseRow.attDate))) {
    return { contacted: false, channel: channelFor(employee, ctx.settings.defaultChannel), purpose: callPurposeFor(caseRow), reason: LOCKED_REASON };
  }
  try {
    return await reach(ctx, caseRow, employee, opts.queueIfBusy ?? true);
  } catch (error) {
    // A provider refusing - an unapproved template, a number not on WhatsApp -
    // is an outcome to report on the case, not a reason to lose the whole batch.
    const reason = (error as Error).message;
    await ctx.tx.update(cases).set({ error: reason, updatedAt: new Date() }).where(eq(cases.id, caseRow.id));
    return {
      contacted: false,
      channel: channelFor(employee, ctx.settings.defaultChannel),
      purpose: callPurposeFor(caseRow),
      reason,
    };
  }
}

async function reach(ctx: FullContext, caseRow: CaseRow, employee: EmployeeRow, queueIfBusy: boolean): Promise<ContactResult> {
  const channel =
    callPurposeFor(caseRow) === 'follow_up'
      ? followUpChannel(employee, ctx.settings, nextFollowUp(caseRow, ctx.settings).number)
      : channelFor(employee, ctx.settings.defaultChannel);

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

  if (purpose === 'follow_up') {
    const result = await sendFollowUp(ctx, caseRow, employee);
    if (result.reached) return { contacted: true, channel, purpose, simulated: result.simulated };
    if ('busy' in result && result.busy) return busy(ctx, caseRow, purpose, queueIfBusy, true);
    return { contacted: false, channel, purpose, reason: result.reason };
  }

  if (channel === 'voice') {
    const result = await placeCaseCall(ctx, caseRow, employee, purpose);
    if (result.placed) return { contacted: true, channel, purpose, simulated: result.simulated };
    if ('busy' in result && result.busy) return busy(ctx, caseRow, purpose, queueIfBusy, false);
    return { contacted: false, channel, purpose, reason: result.reason };
  }

  const result = await askCase(ctx, caseRow, employee);
  return result.sent
    ? { contacted: true, channel, purpose, simulated: result.simulated }
    : { contacted: false, channel, purpose, reason: result.reason };
}

/** Every line was busy: the call waits for one, or - when asked not to queue - that is reported. */
async function busy(ctx: FullContext, caseRow: CaseRow, purpose: CallPurpose, queueIfBusy: boolean, followUp: boolean): Promise<ContactResult> {
  if (!queueIfBusy) return { contacted: false, channel: 'voice', purpose, reason: 'Every call line is busy', busy: true };
  await waitForLine(ctx.tx, ctx.tenantId, { action: 'contact_case', caseId: caseRow.id, followUp });
  return { contacted: true, channel: 'voice', purpose, waiting: true };
}

/** Looks up the employee and contacts them, for callers that only hold a case. */
export async function contactCaseById(ctx: FullContext, caseId: string, opts: ContactOptions = {}): Promise<ContactResult | null> {
  const caseRow = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId) });
  if (!caseRow) return null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
  if (!employee) return null;
  return contactCase(ctx, caseRow, employee, opts);
}
