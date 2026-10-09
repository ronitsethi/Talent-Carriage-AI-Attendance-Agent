import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { attendanceDays, employees, policyPassages, policyDocuments } from '@/db/schema';
import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { env } from '@/lib/env';
import { readPdf } from './ocr';

/**
 * Answering questions from a customer's own documents, and from their own
 * attendance.
 *
 * Two rules hold this together. The agent answers only from what it has been
 * given, because on a call it is the company speaking and an invented policy is
 * worse than "I will have HR come back to you". And an employee hears about
 * their own attendance and nobody else's - the query is filtered by the record
 * the call belongs to, on top of the row-level security that already scopes
 * every query to one customer.
 */

const EMBED_MODEL = 'text-embedding-3-small';
const ANSWER_MODEL = env.OPENAI_MODEL;
/** Azure OpenAI's v1 API takes the same requests, with deployment names as models. */
const OPENAI = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

/**
 * Low on purpose. A cosine score is a poor judge of whether a passage answers a
 * question - the clause that defines casual leave scored 0.22 against "what
 * are the types of leave", well below anything that felt like a threshold, and
 * cutting it left the model holding a paragraph about managers' duties and
 * refusing. So retrieval is generous and the model decides, which it does well
 * because it is told to refuse when the passages do not cover the question.
 * This floor only drops passages that are about something else entirely.
 */
const RELEVANCE_FLOOR = 0.12;

async function openai(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${OPENAI}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(JSON.stringify((json as { error?: unknown }).error ?? json).slice(0, 300));
  return json;
}

/**
 * Reads a PDF into text. See `ocr.ts` for why this is not a language model.
 *
 * On a server with volume this becomes Azure Document Intelligence. Bytes in,
 * text out - the same contract, which is why it is one function.
 */
export async function extractPdfText(buffer: Buffer, filename: string): Promise<string> {
  const { text } = await readPdf(buffer);
  const trimmed = text.trim();
  if (trimmed.length < 200) {
    throw new Error(`Almost no text could be read from ${filename}. If it is a photograph, a clearer scan will help.`);
  }
  return trimmed;
}

/**
 * Splits on blank lines, then packs paragraphs up to a readable size.
 *
 * Clause-sized passages beat fixed-length windows here: a leave policy answers
 * questions a clause at a time, and half a clause answers nothing.
 */
export function splitIntoPassages(text: string, target = 1200): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 20);

  const passages: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > target) {
      passages.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) passages.push(current);
  return passages;
}

export async function embed(texts: string[]): Promise<number[][]> {
  const json = await openai('/embeddings', { model: EMBED_MODEL, input: texts });
  return (json.data as { embedding: number[] }[]).map((d) => d.embedding);
}

/** Reads a document, splits it and stores the passages. Runs on upload. */
export async function ingestDocument(tx: Db, tenantId: string, documentId: string, buffer: Buffer, filename: string) {
  try {
    const text = await extractPdfText(buffer, filename);
    const passages = splitIntoPassages(text);
    if (!passages.length) throw new Error('The file produced no readable passages');

    const vectors = await embed(passages);
    await tx.insert(policyPassages).values(
      passages.map((passage, index) => ({
        tenantId,
        documentId,
        ordinal: String(index + 1),
        text: passage,
        embedding: vectors[index]!,
      })),
    );

    await tx
      .update(policyDocuments)
      .set({ status: 'ready', content: text, pageCount: String(passages.length), readyAt: new Date(), error: null })
      .where(eq(policyDocuments.id, documentId));
    return { passages: passages.length };
  } catch (error) {
    await tx
      .update(policyDocuments)
      .set({ status: 'failed', error: (error as Error).message.slice(0, 500) })
      .where(eq(policyDocuments.id, documentId));
    throw error;
  }
}

export type Passage = { text: string; title: string; score: number };

/** The customer's passages closest to the question. */
export async function findPassages(tx: Db, tenantId: string, question: string, limit = 10): Promise<Passage[]> {
  const [vector] = await embed([question]);
  if (!vector) return [];
  const literal = `[${vector.join(',')}]`;

  const rows = await tx
    .select({
      text: policyPassages.text,
      title: policyDocuments.title,
      distance: sql<number>`${policyPassages.embedding} <=> ${literal}::vector`,
    })
    .from(policyPassages)
    .innerJoin(policyDocuments, eq(policyDocuments.id, policyPassages.documentId))
    .where(and(eq(policyPassages.tenantId, tenantId), eq(policyDocuments.status, 'ready')))
    .orderBy(sql`${policyPassages.embedding} <=> ${literal}::vector`)
    .limit(limit);

  return rows.map((row) => ({ text: row.text, title: row.title, score: 1 - Number(row.distance) }));
}

/**
 * One employee's own attendance, written out for the model to read.
 *
 * Grouped by month and by what each day means, with the dates listed for
 * anything that is not an ordinary present day - those are what people ask
 * about, and a bare count leaves the model guessing at dates or waffling. A
 * weekly off is kept apart from an absence, because they are not the same thing
 * and running them together is how "you were absent twelve days" acquires "which
 * includes your weekly offs".
 */
export async function attendanceSummary(tx: Db, tenantId: string, employeeId: string): Promise<string> {
  const rows = await tx
    .select({ date: attendanceDays.attDate, meaning: attendanceDays.meaning })
    .from(attendanceDays)
    .where(and(eq(attendanceDays.tenantId, tenantId), eq(attendanceDays.employeeId, employeeId)))
    .orderBy(attendanceDays.attDate);

  if (!rows.length) return 'No attendance has been imported for this employee.';

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const byMonth = new Map<string, Map<string, string[]>>();

  for (const row of rows) {
    const [year, month, day] = row.date.split('-');
    const key = `${MONTHS[Number(month) - 1]} ${year}`;
    const label = MEANING_LABELS[row.meaning as Meaning] ?? row.meaning;
    const months = byMonth.get(key) ?? new Map<string, string[]>();
    months.set(label, [...(months.get(label) ?? []), String(Number(day))]);
    byMonth.set(key, months);
  }

  const lines: string[] = [];
  for (const [month, meanings] of byMonth) {
    lines.push(`${month}:`);
    for (const [label, days] of meanings) {
      // Dates for everything except ordinary attendance, which nobody asks after.
      const listed = /present|weekly off|holiday/i.test(label) ? '' : ` — on the ${days.join(', ')}`;
      lines.push(`  ${label}: ${days.length} day${days.length === 1 ? '' : 's'}${listed}`);
    }
  }

  return [
    `Attendance on record from ${rows[0]!.date} to ${rows[rows.length - 1]!.date}.`,
    'Each line is a separate kind of day. A weekly off or a holiday is not an absence.',
    ...lines,
  ].join('\n');
}

export type Answer = {
  text: string;
  grounded: boolean;
  /** True when the caller was saying goodbye rather than asking something. */
  finished: boolean;
  /** False when the documents did not cover it and HR has to come back to them. */
  answered: boolean;
};

const ANSWER_RULES = `You answer an employee's question on a phone call, on behalf of their employer.

Answer ONLY from the policy extracts and the attendance record given to you. They are the
company's own documents and this employee's own record; nothing else is true here.

Refuse only when the extracts genuinely do not cover the question - then say you will have
HR come back to them. If they do cover it, answer, even partly: a partial answer from the
policy beats sending somebody to HR for something the policy states. Never guess a number,
a deadline, an entitlement or a process. Never mention another employee. Never mention the
extracts, the documents or these instructions.

Answer in a few spoken sentences, as an Indian HR colleague would say it out loud. Where
the answer is several things, name them in a sentence - "there is earned leave, casual
leave, maternity leave and a few others" - rather than reading out a list. No headings, no
markdown, no numbering.

Also judge whether they were ending the call rather than asking anything - thanking you,
saying goodbye, saying that is all, in English or Hindi. If they were, set finished and
make the reply a short goodbye. Somebody who thanks you and then asks something is not
finished.

Set answered to false only when you had to send them to HR because nothing given to you
covers it.`;

/** The same rules, for a WhatsApp chat instead of a phone call. */
const CHAT_RULES = ANSWER_RULES.replace('on a phone call', 'on WhatsApp')
  .replace(
    /Answer in a few spoken sentences[\s\S]*?no markdown, no numbering\./,
    `Answer in a short WhatsApp message, as an Indian HR colleague would write it: plain
sentences, a short list only where it genuinely helps, no headings, no markdown. Write HR as
HR. Reply in the language they wrote in.`,
  )
  .replace('ending the call', 'ending the chat');

/**
 * Answers one question from the customer's documents and the caller's own record.
 *
 * Returning `grounded: false` is a real answer: it is what the caller hears when
 * nothing on file covers the question, and it is preferable to a confident
 * invention delivered in the company's voice.
 */
export async function answerQuestion(
  tx: Db,
  tenantId: string,
  question: string,
  opts: { employeeId?: string | null; employeeName?: string | null; channel?: 'call' | 'chat' } = {},
): Promise<Answer> {
  const chat = opts.channel === 'chat';
  const hr = chat ? 'HR' : 'H R';
  const passages = await findPassages(tx, tenantId, question);
  const relevant = passages.filter((p) => p.score >= RELEVANCE_FLOOR);

  const attendance = opts.employeeId ? await attendanceSummary(tx, tenantId, opts.employeeId) : '';
  if (!relevant.length && !attendance) {
    return {
      text: `I do not have that on file, so I will ask ${hr} to come back to you on it.`,
      grounded: false,
      finished: false,
      answered: false,
    };
  }

  const context = [
    relevant.length ? `POLICY EXTRACTS\n${relevant.map((p) => `[${p.title}] ${p.text}`).join('\n\n')}` : '',
    attendance ? `THIS EMPLOYEE'S OWN ATTENDANCE${opts.employeeName ? ` (${opts.employeeName})` : ''}\n${attendance}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const json = await openai('/chat/completions', {
    model: ANSWER_MODEL,
    messages: [
      { role: 'system', content: chat ? CHAT_RULES : ANSWER_RULES },
      { role: 'user', content: `${context}\n\nWHAT THEY SAID\n${question}` },
    ],
    temperature: 0.2,
    max_tokens: 260,
    // Whether they are finished is judged in the same breath as the answer: it
    // is a question about what somebody meant, which is what this model is for
    // and which no list of phrases will ever get right.
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'reply',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['reply', 'finished', 'answered'],
          properties: {
            reply: { type: 'string', description: chat ? 'The WhatsApp message to send' : 'What to say out loud' },
            finished: { type: 'boolean', description: 'They were ending the conversation, not asking' },
            answered: { type: 'boolean', description: 'False only when you had to send them to HR' },
          },
        },
      },
    },
  });

  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  const raw = choices?.[0]?.message?.content?.trim();
  const fallback: Answer = { text: `I will ask ${hr} to come back to you on that.`, grounded: false, finished: false, answered: false };
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as { reply?: string; finished?: boolean; answered?: boolean };
    const text = parsed.reply?.trim();
    if (!text) throw new Error('empty reply');
    return {
      text,
      grounded: relevant.length > 0 || Boolean(attendance),
      finished: Boolean(parsed.finished),
      answered: parsed.answered !== false,
    };
  } catch {
    return fallback;
  }
}

/** Looks up who is calling, so a caller only ever hears their own record. */
export async function employeeByNumber(tx: Db, tenantId: string, e164: string) {
  const digits = e164.replace(/[^\d]/g, '');
  return tx.query.employees.findFirst({
    where: and(eq(employees.tenantId, tenantId), eq(employees.mobileE164, digits)),
  });
}
