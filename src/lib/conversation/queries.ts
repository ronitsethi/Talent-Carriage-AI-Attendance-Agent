import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { messages, queries } from '@/db/schema';
import { enqueue } from '@/lib/jobs/queue';

/**
 * Queries: what an employee asks us of their own accord.
 *
 * An absence we ask about is a case, and its whole conversation lives with the
 * case. Anything else an employee raises - ringing us, or writing on WhatsApp
 * when no date is being discussed - is a query, kept apart so HR can see what
 * people ask without wading through the follow-ups.
 *
 * A call is one query from pick-up to hang-up. A chat has no hang-up, so it is
 * one query until it has been quiet for half an hour; the next message after
 * that starts another.
 */

export const QUERY_QUIET_MS = 30 * 60_000;

export type QueryLine = { role: 'agent' | 'employee'; text: string };

/** The chat query this message belongs to: the one still going, or a new one. */
export async function whatsappQuery(tx: Db, tenantId: string, employeeId: string, at: Date): Promise<string> {
  const open = await tx.query.queries.findFirst({
    where: and(
      eq(queries.employeeId, employeeId),
      eq(queries.channel, 'whatsapp'),
      gt(queries.lastActivityAt, new Date(at.getTime() - QUERY_QUIET_MS)),
    ),
    orderBy: desc(queries.lastActivityAt),
    columns: { id: true },
  });
  if (open) {
    await tx.update(queries).set({ lastActivityAt: at }).where(eq(queries.id, open.id));
    return open.id;
  }
  const [created] = await tx
    .insert(queries)
    .values({ tenantId, employeeId, channel: 'whatsapp', startedAt: at, lastActivityAt: at })
    .returning({ id: queries.id });
  return created!.id;
}

/** Files messages under a query, and marks it as having moved on. */
export async function addMessagesToQuery(tx: Db, queryId: string, messageIds: string[]) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return;
  await tx.update(messages).set({ queryId }).where(inArray(messages.id, ids));
  await tx.update(queries).set({ lastActivityAt: new Date() }).where(eq(queries.id, queryId));
}

/** A call somebody made to us, opened with whatever the agent greeted them with. */
export async function startCallQuery(
  tx: Db,
  args: { tenantId: string; employeeId: string; style: 'agent' | 'keypad'; providerCallId?: string | null; greeting?: string },
): Promise<string> {
  const at = new Date();
  const [created] = await tx
    .insert(queries)
    .values({
      tenantId: args.tenantId,
      employeeId: args.employeeId,
      channel: 'voice',
      callStyle: args.style,
      providerCallId: args.providerCallId ?? null,
      startedAt: at,
      lastActivityAt: at,
      transcript: args.greeting ? [{ role: 'agent', text: args.greeting, at: at.toISOString() }] : [],
    })
    .returning({ id: queries.id });
  return created!.id;
}

/**
 * Adds a turn to a call query: what they said and what they were told.
 *
 * `heard`, when given, is how much of the agent's last line they heard before
 * cutting it off - the same bookkeeping a call we placed keeps.
 */
export async function addCallTurn(tx: Db, queryId: string, employeeId: string, lines: QueryLine[], heard?: string | null) {
  const query = await tx.query.queries.findFirst({
    where: and(eq(queries.id, queryId), eq(queries.employeeId, employeeId)),
    columns: { transcript: true },
  });
  if (!query) return;
  const transcript = [...(query.transcript ?? [])];
  if (heard != null) {
    const last = transcript.map((line) => line.role).lastIndexOf('agent');
    if (last >= 0 && transcript[last]!.text.trim() !== heard.trim()) transcript[last] = { ...transcript[last]!, heard };
  }
  const at = new Date();
  transcript.push(...lines.filter((line) => line.text.trim()).map((line) => ({ ...line, at: at.toISOString() })));
  await tx.update(queries).set({ transcript, lastActivityAt: at }).where(eq(queries.id, queryId));
}

/** How long after a call to us its feedback is asked for. */
export const FEEDBACK_AFTER_MS = 60_000;

/**
 * The call is over; its recording, when there is one, is where `recordingUri`
 * says. The first time it is marked over, its feedback is queued for a minute
 * later - the worker and the recording both report the end, and only one asks.
 */
export async function endCallQuery(tx: Db, queryId: string, recordingUri?: string | null) {
  const [ended] = await tx
    .update(queries)
    .set({ endedAt: new Date() })
    .where(and(eq(queries.id, queryId), isNull(queries.endedAt)))
    .returning({ tenantId: queries.tenantId, endedAt: queries.endedAt });
  if (recordingUri) await tx.update(queries).set({ recordingUri }).where(eq(queries.id, queryId));
  if (ended) {
    await enqueue(
      'query_feedback',
      { queryId },
      { tenantId: ended.tenantId, runAt: new Date(ended.endedAt!.getTime() + FEEDBACK_AFTER_MS), dedupeKey: `feedback:${queryId}` },
      tx,
    );
  }
}

/**
 * The date the employee was last in conversation about, if that was within the
 * last half hour: whatever they write in that time is part of it. Either side
 * of the conversation counts, on WhatsApp or on a call.
 */
export async function recentCaseContact(
  tx: Db,
  employeeId: string,
  at: Date,
  excludeMessageId?: string,
): Promise<{ caseId: string; at: Date } | null> {
  const rows = await tx.execute<{ case_id: string; at: string }>(sql`
    select case_id, at from (
      select m.case_id, coalesce(m.sent_at, m.created_at) as at
      from messages m join conversations c on c.id = m.conversation_id
      where c.employee_id = ${employeeId} and m.case_id is not null and m.query_id is null
        and m.id <> ${excludeMessageId ?? '00000000-0000-0000-0000-000000000000'}
      union all
      select k.case_id, coalesce(k.ended_at, k.started_at) as at
      from calls k
      where k.employee_id = ${employeeId} and k.case_id is not null and k.started_at is not null
    ) contact
    order by at desc
    limit 1
  `);
  const last = rows.rows[0];
  if (!last) return null;
  const when = new Date(last.at);
  return at.getTime() - when.getTime() < QUERY_QUIET_MS ? { caseId: last.case_id, at: when } : null;
}
