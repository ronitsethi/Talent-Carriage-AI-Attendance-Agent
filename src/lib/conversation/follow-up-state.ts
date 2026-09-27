import { eq } from 'drizzle-orm';
import { cases } from '@/db/schema';
import type { CaseRow, EngineContext } from './engine';
import type { FollowUpChoice } from './flow';

/**
 * Records the answer to a day-2 reminder, and nothing else.
 *
 * WhatsApp and the call both end up here, so a "Done" tapped in a chat and a 1
 * pressed on a keypad leave the case in exactly the same state. Saying it back
 * to the employee is the caller's job, because the two channels say it
 * differently - which is also why this sits apart from either of them.
 */
export async function recordFollowUpChoice(ctx: EngineContext, caseRow: CaseRow, choice: FollowUpChoice) {
  const at = new Date();

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

  // The reminder has now been both sent and answered, whichever way it went.
  await ctx.tx
    .update(cases)
    .set({ followUpSentAt: caseRow.followUpSentAt ?? at, updatedAt: at })
    .where(eq(cases.id, caseRow.id));

  return { choice };
}
