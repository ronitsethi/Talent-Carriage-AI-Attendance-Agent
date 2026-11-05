import { sql } from 'drizzle-orm';
import { withPlatformScope } from '@/db';

/**
 * The phone lines every call shares: no more than `callLineLimit()` calls at once (3),
 * across every customer - calls we place (first questions, follow-ups, final
 * notices, manager approvals) and calls employees make to us. The one voice
 * worker can only carry about three talking calls; a fourth would ring and be
 * answered by silence.
 *
 * A line is a row in `call_lines`, taken in a transaction of its own so every
 * other process sees it at once. Nothing has to give it back: a line is free
 * again as soon as what holds it has ended -
 *  - a call: its row says completed, failed or simulated, or has an end time;
 *  - an incoming call: its query has an end time;
 *  - a hold whose call row never appeared, because the caller's transaction
 *    rolled back, after two minutes;
 *  - anything, after 45 minutes, so a lost hangup cannot hold a line for ever.
 *
 * Later (filed for when LiveKit is upgraded): the limit becomes per customer.
 */

/**
 * How many lines there are: 3, or `CALL_LINES` in the environment (at most 20,
 * the rows `call_lines` holds).
 */
export const callLineLimit = () => Math.min(20, Math.max(1, Math.floor(Number(process.env.CALL_LINES ?? 3)) || 3));

export type LineHolder = { kind: 'call' | 'query'; id: string };

/** A free line's condition, for the row `l`. */
const FREE = sql`(
  l.holder_id is null
  or l.taken_at < now() - interval '45 minutes'
  or (l.holder_kind = 'call' and (
    exists (select 1 from calls c where c.id = l.holder_id and (c.status in ('completed', 'failed', 'simulated') or c.ended_at is not null))
    or (not exists (select 1 from calls c where c.id = l.holder_id) and l.taken_at < now() - interval '2 minutes')
  ))
  or (l.holder_kind = 'query' and (
    exists (select 1 from queries q where q.id = l.holder_id and q.ended_at is not null)
    or (not exists (select 1 from queries q where q.id = l.holder_id) and l.taken_at < now() - interval '2 minutes')
  ))
)`;

/**
 * Takes a line for `holder`, or returns false when all are busy. With `number`,
 * also false while that number is already on a call with us, so nobody is rung
 * twice at once - a follow-up and a first question, say.
 */
export async function takeCallLine(holder: LineHolder, number?: string | null): Promise<boolean> {
  return withPlatformScope(async (tx) => {
    if (number) {
      const { rows } = await tx.execute<{ busy: boolean }>(sql`
        select exists (
          select 1 from call_lines l join calls c on c.id = l.holder_id
          where l.holder_kind = 'call' and l.id <= ${callLineLimit()} and c.to_number = ${number} and not ${FREE}
        ) as busy`);
      if (rows[0]?.busy) return false;
    }
    const { rows } = await tx.execute<{ id: number }>(sql`
      update call_lines set holder_kind = ${holder.kind}, holder_id = ${holder.id}, taken_at = now()
      where id = (
        select l.id from call_lines l
        where l.id <= ${callLineLimit()} and ${FREE}
        order by l.id
        limit 1
        for update skip locked
      )
      returning id`);
    return rows.length > 0;
  });
}

/** How many lines are in use now, for the portal and tests. */
export async function linesInUse(): Promise<number> {
  return withPlatformScope(async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(sql`select count(*)::int as n from call_lines l where l.id <= ${callLineLimit()} and not ${FREE}`);
    return rows[0]?.n ?? 0;
  });
}

/** Frees every line. For tests only. */
export async function clearCallLines(): Promise<void> {
  await withPlatformScope((tx) => tx.execute(sql`update call_lines set holder_kind = null, holder_id = null, taken_at = null`));
}

/** What a caller is told when every line is busy. */
export const LINES_BUSY = 'All our lines are busy right now. Please try again in a few minutes.';
