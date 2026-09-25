import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { cases, employees } from '@/db/schema';
import type { Meaning } from '@/lib/mapping/meanings';
import {
  canSend,
  chainNextPending,
  getConversation,
  sendButtons,
  sendPlainText,
  windowOpen,
  type CaseRow,
  type EmployeeRow,
  type EngineContext,
} from './engine';
import {
  dateLabel,
  followUpAcknowledgement,
  followUpMessage,
  followUpSelectionId,
  type FollowUpChoice,
  type OptionNumber,
} from './flow';

/**
 * The day-2 reminder.
 *
 * It exists only for dates the employee actually answered - an ignored question
 * is never chased. Before sending, the case is re-checked, so anyone who has
 * since sorted it out hears nothing.
 */
export async function sendDueFollowUps(ctx: EngineContext, at = new Date()) {
  const due = await ctx.tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.tenantId, ctx.tenantId),
        eq(cases.status, 'answered'),
        isNull(cases.followUpSentAt),
        lte(cases.followUpDueAt, at),
      ),
    )
    .orderBy(asc(cases.followUpDueAt))
    .limit(200);

  let sent = 0;
  const skipped: string[] = [];

  for (const caseRow of due) {
    const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
    if (!employee) continue;

    const block = canSend(ctx, employee);
    if (block.blocked) {
      skipped.push(block.reason);
      continue;
    }
    if (!caseRow.replyOption) continue;

    const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
    const { body, buttons } = followUpMessage(caseRow.replyOption as OptionNumber, label);
    const ids: FollowUpChoice[] = ['done', 'not_done', 'help'];

    await sendButtons(
      ctx,
      employee,
      body,
      buttons.map((title, index) => ({ id: followUpSelectionId(caseRow.id, ids[index]!), title })),
      caseRow.id,
    );
    await ctx.tx.update(cases).set({ followUpSentAt: at, updatedAt: at }).where(eq(cases.id, caseRow.id));
    sent++;
  }

  return { due: due.length, sent, skipped };
}

/** What the employee said to the reminder decides whether a call follows. */
export async function handleFollowUpResponse(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  choice: FollowUpChoice,
) {
  const at = new Date();
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);

  if (choice === 'done') {
    // Trust but verify: the HRMS sync confirms it, and closes the case for good.
    await ctx.tx
      .update(cases)
      .set({
        status: 'resolved',
        followUpReply: 'done',
        resolvedAt: at,
        closeReason: 'Employee confirmed it is done; pending HRMS verification',
        callDueAt: null,
        updatedAt: at,
      })
      .where(eq(cases.id, caseRow.id));
  } else if (choice === 'not_done') {
    await ctx.tx
      .update(cases)
      .set({
        followUpReply: 'not_done',
        callDueAt: new Date(at.getTime() + 86_400_000),
        updatedAt: at,
      })
      .where(eq(cases.id, caseRow.id));
  } else {
    await ctx.tx
      .update(cases)
      .set({
        status: 'needs_hr',
        followUpReply: 'help',
        needsHrReason: 'Employee asked for help at the day-2 reminder',
        updatedAt: at,
      })
      .where(eq(cases.id, caseRow.id));
  }

  await sendPlainText(ctx, employee, followUpAcknowledgement(choice, label), caseRow.id);
  if (choice === 'done') await chainNextPending(ctx, employee, caseRow.id);
  return { choice };
}
