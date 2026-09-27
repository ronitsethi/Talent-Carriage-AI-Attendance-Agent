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
import { channelFor } from '@/lib/channel';
import { recordFollowUpChoice } from './follow-up-state';
import { placeCaseCall, type VoiceContext } from '@/lib/voice/session';
import {
  dateLabel,
  followUpAcknowledgement,
  followUpMessage,
  followUpSelectionId,
  type FollowUpChoice,
  type OptionNumber,
} from './flow';

/**
 * Reminders need to know how to reach people. On WhatsApp the engine context is
 * enough; a call also needs the voice provider, which a tenant may not have.
 */
type FollowUpContext = EngineContext & Partial<Pick<VoiceContext, 'voice' | 'baseUrl'>>;

/** Sends one reminder on WhatsApp, with the three buttons it is answered by. */
export async function sendFollowUpMessage(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, at = new Date()) {
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
}

/**
 * The day-2 reminder.
 *
 * It exists only for dates the employee actually answered - an ignored question
 * is never chased. Before sending, the case is re-checked, so anyone who has
 * since sorted it out hears nothing.
 *
 * The reminder goes out on the same channel the employee is set to. On
 * WhatsApp that is one message per date; on the phone it is one call per
 * person, which then works through their dates the way the first call does -
 * nobody should be rung five times in a morning.
 */
export async function sendDueFollowUps(ctx: FollowUpContext, at = new Date()) {
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
    // Oldest absence first, not earliest reminder. Within one person the two
    // differ - a call answers the newest date before sweeping backwards, so the
    // newest date's reminder falls due first - and the employee should be rung
    // about their oldest outstanding day, as everywhere else in this flow.
    .orderBy(asc(cases.attDate))
    .limit(200);

  let sent = 0;
  let called = 0;
  const skipped: string[] = [];
  const rungAlready = new Set<string>();

  for (const caseRow of due) {
    const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
    if (!employee) continue;

    const block = canSend(ctx, employee);
    if (block.blocked) {
      skipped.push(block.reason);
      continue;
    }
    if (!caseRow.replyOption) continue;

    if (channelFor(employee, ctx.settings.defaultChannel) === 'voice') {
      if (!ctx.voice) {
        skipped.push('No voice provider configured');
        continue;
      }
      // One call per person: the oldest due date rings, and the call sweeps the
      // rest of their dates itself.
      if (rungAlready.has(employee.id)) continue;
      rungAlready.add(employee.id);

      const result = await placeCaseCall(ctx as VoiceContext, caseRow, employee, 'follow_up');
      if (result.placed) called++;
      else skipped.push(result.reason);
      continue;
    }

    await sendFollowUpMessage(ctx, caseRow, employee, at);
    sent++;
  }

  return { due: due.length, sent, called, skipped };
}

/** What the employee said to the reminder decides whether a call follows. */
export async function handleFollowUpResponse(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  choice: FollowUpChoice,
) {
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  await recordFollowUpChoice(ctx, caseRow, choice);

  await sendPlainText(ctx, employee, followUpAcknowledgement(choice, label), caseRow.id);
  if (choice === 'done') await chainNextPending(ctx, employee, caseRow.id);
  return { choice };
}
