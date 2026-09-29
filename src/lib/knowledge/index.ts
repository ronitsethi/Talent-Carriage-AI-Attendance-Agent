import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { attendanceDays, employees, policyPassages, policyDocuments } from '@/db/schema';
import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { env } from '@/lib/env';

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
const ANSWER_MODEL = 'gpt-4o-mini';
const OPENAI = 'https://api.openai.com/v1';

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
 * Reads a PDF, including a scanned one.
 *
 * The model is given the file itself rather than text pulled out of it, because
 * the guideline documents customers actually send are page images with no text
 * layer at all.
 */
export async function extractPdfText(buffer: Buffer, filename: string): Promise<string> {
  const json = await openai('/chat/completions', {
    model: ANSWER_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Transcribe this document to plain text, keeping its headings, numbered clauses and tables in reading order. ' +
              'Output only the transcription.',
          },
          {
            type: 'file',
            file: { filename, file_data: `data:application/pdf;base64,${buffer.toString('base64')}` },
          },
        ],
      },
    ],
    max_tokens: 16000,
  });
  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  const text = choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('Nothing could be read from this file');
  return text;
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

/** One employee's own attendance, as a few lines the model can read. */
export async function attendanceSummary(tx: Db, tenantId: string, employeeId: string): Promise<string> {
  const rows = await tx
    .select({ date: attendanceDays.attDate, meaning: attendanceDays.meaning, raw: attendanceDays.rawStatus })
    .from(attendanceDays)
    .where(and(eq(attendanceDays.tenantId, tenantId), eq(attendanceDays.employeeId, employeeId)))
    .orderBy(attendanceDays.attDate);

  if (!rows.length) return 'No attendance has been imported for this employee.';

  const counts = new Map<string, string[]>();
  for (const row of rows) {
    const label = MEANING_LABELS[row.meaning as Meaning] ?? row.meaning;
    counts.set(label, [...(counts.get(label) ?? []), row.date]);
  }

  const lines = [...counts.entries()].map(([label, dates]) => {
    // Dates matter for absences; for a hundred present days a count is plenty.
    const detail = dates.length <= 12 ? `: ${dates.join(', ')}` : '';
    return `${label}: ${dates.length} day${dates.length === 1 ? '' : 's'}${detail}`;
  });

  return `Attendance on record from ${rows[0]!.date} to ${rows[rows.length - 1]!.date}.\n${lines.join('\n')}`;
}

export type Answer = { text: string; grounded: boolean };

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
markdown, no numbering.`;

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
  opts: { employeeId?: string | null; employeeName?: string | null } = {},
): Promise<Answer> {
  const passages = await findPassages(tx, tenantId, question);
  const relevant = passages.filter((p) => p.score >= RELEVANCE_FLOOR);

  const attendance = opts.employeeId ? await attendanceSummary(tx, tenantId, opts.employeeId) : '';
  if (!relevant.length && !attendance) {
    return { text: 'I do not have that on file, so I will ask H R to come back to you on it.', grounded: false };
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
      { role: 'system', content: ANSWER_RULES },
      { role: 'user', content: `${context}\n\nTHE QUESTION\n${question}` },
    ],
    temperature: 0.2,
    max_tokens: 220,
  });

  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  const text = choices?.[0]?.message?.content?.trim();
  if (!text) return { text: 'I will ask H R to come back to you on that.', grounded: false };
  return { text, grounded: relevant.length > 0 || Boolean(attendance) };
}

/** Looks up who is calling, so a caller only ever hears their own record. */
export async function employeeByNumber(tx: Db, tenantId: string, e164: string) {
  const digits = e164.replace(/[^\d]/g, '');
  return tx.query.employees.findFirst({
    where: and(eq(employees.tenantId, tenantId), eq(employees.mobileE164, digits)),
  });
}
