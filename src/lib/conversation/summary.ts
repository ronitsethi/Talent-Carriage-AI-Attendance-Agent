import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { calls, cases, messages, queries } from '@/db/schema';
import { env } from '@/lib/env';
import { assertBudget } from '@/lib/models/budget';
import { openai } from '@/lib/knowledge';
import { withCostScope } from '@/lib/costs/record';

/**
 * Summaries of a conversation, for HR reading a case or a query.
 *
 * Written the first time somebody opens the page and kept, then written again
 * only once something new has been said - so nothing is spent on conversations
 * nobody looks at, and nothing is spent twice on one that has not moved.
 */

export type Line = { role: 'agent' | 'employee'; text: string; at: string; heard?: string };

type CaseRow = typeof cases.$inferSelect;
type QueryRow = typeof queries.$inferSelect;

/*
 * When a message was said. A reply is saved in the same transaction as the
 * message it answers, and so carries the same `created_at`; its `sent_at` is
 * when it actually went, which is what puts it after the question.
 */
export const messageTime = sql<Date>`coalesce(${messages.sentAt}, ${messages.createdAt})`.mapWith(
  (value: string | Date) => new Date(value),
);

/**
 * The calls that discussed a case's date: the one placed about it, and any
 * placed about another date that went on to settle this one - a call goes
 * through every pending date, and leaves a note against each date it settles
 * while it is going on. Calls about the employee's other dates are not this
 * case's, and a case answered on WhatsApp has none.
 */
export async function callsForCase(tx: Db, caseRow: CaseRow) {
  return tx
    .select()
    .from(calls)
    .where(
      and(
        eq(calls.employeeId, caseRow.employeeId),
        // A manager rung to approve it is not part of the employee's conversation.
        sql`${calls.purpose} <> 'manager_approval'`,
        or(
          eq(calls.caseId, caseRow.id),
          sql`exists (
            select 1 from messages m
            where m.case_id = ${caseRow.id} and m.channel = 'voice'
              and m.created_at between ${calls.startedAt} and coalesce(${calls.endedAt}, ${calls.startedAt} + interval '1 hour')
          )`,
        ),
      ),
    )
    .orderBy(sql`${calls.startedAt} desc nulls last`);
}

/** A case's conversation: its WhatsApp messages and its calls, in order. */
export async function caseConversation(tx: Db, caseRow: CaseRow): Promise<Line[]> {
  const [chat, rang] = await Promise.all([
    tx
      .select({ direction: messages.direction, body: messages.body, at: messageTime })
      .from(messages)
      .where(and(eq(messages.caseId, caseRow.id), isNull(messages.queryId), eq(messages.channel, 'whatsapp')))
      .orderBy(messageTime),
    callsForCase(tx, caseRow),
  ]);
  const lines: Line[] = [
    ...chat
      .filter((m) => m.body?.trim())
      .map((m) => ({ role: m.direction === 'inbound' ? ('employee' as const) : ('agent' as const), text: m.body!, at: m.at.toISOString() })),
    ...rang.flatMap((c) => c.transcript ?? []),
  ];
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

/** A query's conversation: a call's turns, or the chat's messages. */
export async function queryConversation(tx: Db, query: QueryRow): Promise<Line[]> {
  if (query.channel === 'voice') return query.transcript ?? [];
  const chat = await tx
    .select({ direction: messages.direction, body: messages.body, at: messageTime })
    .from(messages)
    .where(eq(messages.queryId, query.id))
    .orderBy(messageTime);
  return chat
    .filter((m) => m.body?.trim())
    .map((m) => ({ role: m.direction === 'inbound' ? ('employee' as const) : ('agent' as const), text: m.body!, at: m.at.toISOString() }));
}

const lastSaid = (lines: Line[]) => lines.reduce<string | null>((latest, line) => (!latest || line.at > latest ? line.at : latest), null);

/** Whether the summary is missing, or older than the last thing said. */
export function summaryIsStale(summarisedAt: Date | null, lines: Line[]): boolean {
  const last = lastSaid(lines);
  if (!last) return false;
  return !summarisedAt || summarisedAt.toISOString() < last;
}

export function transcriptText(lines: Line[]): string {
  return lines
    .map((line) => {
      const who = line.role === 'agent' ? 'Agent' : 'Employee';
      if (line.heard === undefined) return `${who}: ${line.text}`;
      return line.heard.trim()
        ? `${who} (cut off; the employee heard only this): ${line.heard}`
        : `${who} (the employee did not hear this): ${line.text}`;
    })
    .join('\n')
    .slice(-12_000);
}

/** One structured answer from the model, charged to the channel's allowance. Shared with the ticket writer. */
export async function ask<T>(
  system: string,
  transcript: string,
  schema: Record<string, unknown>,
  budget: 'call' | 'whatsapp',
  maxTokens = 500,
  purpose = 'Summary',
): Promise<T> {
  await assertBudget(budget);
  const json = await openai(
    '/chat/completions',
    {
      model: env.OPENAI_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_schema', json_schema: { name: 'summary', strict: true, schema } },
    },
    budget,
    purpose,
  );
  const content = (json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '';
  return JSON.parse(content) as T;
}

const CASE_PROMPT =
  'You summarise, for an HR team, a conversation between an attendance assistant and an employee about a day the ' +
  'attendance shows them absent. It may be a WhatsApp chat or a phone call, in English, Hindi or a mix. Write one ' +
  'short paragraph in plain English, two to four sentences: what the employee said happened, what they were told to ' +
  'do, and anything still open or needing H R. Use only what is in the conversation; do not guess. No headings or lists.';

/** The case's overall summary: the one kept, or a new one if something has been said since. */
export async function summariseCase(tx: Db, caseRow: CaseRow): Promise<string | null> {
  const lines = await caseConversation(tx, caseRow);
  if (!lines.length) return null;
  if (!summaryIsStale(caseRow.summarisedAt, lines)) return caseRow.summary;

  // Counted with the case, whichever page asked for it.
  const { summary } = await withCostScope({ tenantId: caseRow.tenantId, caseId: caseRow.id }, () => ask<{ summary: string }>(
    CASE_PROMPT,
    `THE DATE THIS CASE IS ABOUT: ${caseRow.attDate}. The conversation may also cover other dates: summarise only what ` +
      `concerns this one, and do not mention the others.\n\n${transcriptText(lines)}`,
    { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
    caseRow.channel === 'voice' ? 'call' : 'whatsapp',
  ));
  await tx.update(cases).set({ summary, summarisedAt: new Date() }).where(eq(cases.id, caseRow.id));
  return summary;
}

const QUERY_PROMPT =
  'You summarise, for an HR team, a conversation in which an employee asked an HR assistant questions, by phone or ' +
  'WhatsApp, in English, Hindi or a mix. Return two lists in plain English. queries: every question or request the ' +
  'employee raised, one short line each, in the order they raised them; leave out greetings and thanks. reply: what ' +
  'the assistant answered to each, one short line each, in the same order - including when it said H R would come ' +
  'back to them, or could not answer. Use only what is in the conversation; do not guess.';

/** A query's two summaries - what was asked, and what was answered - kept or written afresh. */
export async function summariseQuery(tx: Db, query: QueryRow): Promise<{ queries: string; reply: string } | null> {
  const lines = await queryConversation(tx, query);
  if (!lines.some((line) => line.role === 'employee')) return null;
  if (!summaryIsStale(query.summarisedAt, lines)) {
    return { queries: query.summaryQueries ?? '', reply: query.summaryReply ?? '' };
  }

  const result = await withCostScope({ tenantId: query.tenantId, queryId: query.id }, () => ask<{ queries: string[]; reply: string[] }>(
    QUERY_PROMPT,
    transcriptText(lines),
    {
      type: 'object',
      additionalProperties: false,
      required: ['queries', 'reply'],
      properties: { queries: { type: 'array', items: { type: 'string' } }, reply: { type: 'array', items: { type: 'string' } } },
    },
    query.channel === 'voice' ? 'call' : 'whatsapp',
  ));
  const summary = { queries: result.queries.join('\n'), reply: result.reply.join('\n') };
  await tx
    .update(queries)
    .set({ summaryQueries: summary.queries, summaryReply: summary.reply, summarisedAt: new Date() })
    .where(eq(queries.id, query.id));
  return summary;
}
