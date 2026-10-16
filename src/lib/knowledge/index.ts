import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { attendanceDays, employees, policyPassages, policyDocuments } from '@/db/schema';
import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { env } from '@/lib/env';
import { timed } from '@/lib/timing';
import { assertBudget, BudgetExhausted, chargeBudget, type AiBudget } from '@/lib/models/budget';
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
export const RELEVANCE_FLOOR = 0.12;

export async function openai(path: string, body: { model: string; [key: string]: unknown }, budget?: AiBudget): Promise<Record<string, unknown>> {
  const label = path === '/embeddings' ? 'embed' : 'answer_model';
  const { response, json } = await timed(label, async () => {
    const response = await fetch(`${OPENAI}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    return { response, json: (await response.json()) as Record<string, unknown> };
  });
  if (!response.ok) throw new Error(JSON.stringify((json as { error?: unknown }).error ?? json).slice(0, 300));
  if (budget) {
    const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    // Recorded without waiting: on a call the answer is what matters next.
    void chargeBudget(budget, body.model, { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens }).catch(
      (error) => console.error('[budget] could not record the cost:', (error as Error).message),
    );
  }
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

export async function embed(texts: string[], budget?: AiBudget): Promise<number[][]> {
  const json = await openai('/embeddings', { model: EMBED_MODEL, input: texts }, budget);
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
export async function findPassages(
  tx: Db,
  tenantId: string,
  question: string,
  limit = 10,
  budget?: AiBudget,
): Promise<Passage[]> {
  const [vector] = await embed([question], budget);
  if (!vector) return [];
  const literal = `[${vector.join(',')}]`;

  const rows = await timed('search_db', () => tx
    .select({
      text: policyPassages.text,
      title: policyDocuments.title,
      distance: sql<number>`${policyPassages.embedding} <=> ${literal}::vector`,
    })
    .from(policyPassages)
    .innerJoin(policyDocuments, eq(policyDocuments.id, policyPassages.documentId))
    .where(and(eq(policyPassages.tenantId, tenantId), eq(policyDocuments.status, 'ready')))
    .orderBy(sql`${policyPassages.embedding} <=> ${literal}::vector`)
    .limit(limit));

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

type AnswerOptions = {
  employeeId?: string | null;
  employeeName?: string | null;
  channel?: 'call' | 'chat';
  /** Which allowance this costs; none for questions asked in the portal. */
  budget?: AiBudget;
};

/**
 * What the model returns. The order matters: structured outputs write the keys
 * in the order the schema lists them, so the two flags arrive first and the
 * reply can be spoken while it is still being written.
 */
function replyFormat(chat: boolean) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'reply',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['finished', 'answered', 'reply'],
        properties: {
          // Whether they are finished is judged in the same breath as the
          // answer: it is a question about what somebody meant, which is what
          // this model is for and which no list of phrases will ever get right.
          finished: { type: 'boolean', description: 'They were ending the conversation, not asking' },
          answered: { type: 'boolean', description: 'False only when you had to send them to HR' },
          reply: { type: 'string', description: chat ? 'The WhatsApp message to send' : 'What to say out loud' },
        },
      },
    },
  };
}

type Prepared =
  | { ready: Answer }
  | { request: { model: string; [key: string]: unknown }; fallback: Answer };

/** Everything before the model: the allowance, the passages and the caller's own record. */
async function prepareAnswer(tx: Db, tenantId: string, question: string, opts: AnswerOptions): Promise<Prepared> {
  const chat = opts.channel === 'chat';
  const hr = chat ? 'HR' : 'H R';
  const fallback: Answer = { text: `I will ask ${hr} to come back to you on that.`, grounded: false, finished: false, answered: false };

  // With the allowance spent, the question goes to HR, as one the documents do
  // not cover does.
  if (opts.budget) {
    try {
      await assertBudget(opts.budget);
    } catch (error) {
      if (error instanceof BudgetExhausted) return { ready: fallback };
      throw error;
    }
  }

  // Neither lookup needs the other, and on a call both are silence.
  const [passages, attendance] = await Promise.all([
    findPassages(tx, tenantId, question, 10, opts.budget),
    opts.employeeId ? timed('attendance_db', () => attendanceSummary(tx, tenantId, opts.employeeId!)) : '',
  ]);
  const relevant = passages.filter((p) => p.score >= RELEVANCE_FLOOR);
  if (!relevant.length && !attendance) {
    return {
      ready: {
        text: `I do not have that on file, so I will ask ${hr} to come back to you on it.`,
        grounded: false,
        finished: false,
        answered: false,
      },
    };
  }

  const context = [
    relevant.length ? `POLICY EXTRACTS\n${relevant.map((p) => `[${p.title}] ${p.text}`).join('\n\n')}` : '',
    attendance ? `THIS EMPLOYEE'S OWN ATTENDANCE${opts.employeeName ? ` (${opts.employeeName})` : ''}\n${attendance}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    fallback,
    request: {
      model: ANSWER_MODEL,
      messages: [
        { role: 'system', content: chat ? CHAT_RULES : ANSWER_RULES },
        { role: 'user', content: `${context}\n\nWHAT THEY SAID\n${question}` },
      ],
      temperature: 0.2,
      max_tokens: 260,
      response_format: replyFormat(chat),
    },
  };
}

/** The model's JSON, read into an answer; anything unreadable is the fallback. */
function readReply(raw: string | undefined, fallback: Answer): Answer {
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as { reply?: string; finished?: boolean; answered?: boolean };
    const text = parsed.reply?.trim();
    if (!text) throw new Error('empty reply');
    return { text, grounded: true, finished: Boolean(parsed.finished), answered: parsed.answered !== false };
  } catch {
    return fallback;
  }
}

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
  opts: AnswerOptions = {},
): Promise<Answer> {
  const prepared = await prepareAnswer(tx, tenantId, question, opts);
  if ('ready' in prepared) return prepared.ready;

  const json = await openai('/chat/completions', prepared.request, opts.budget);
  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  return readReply(choices?.[0]?.message?.content, prepared.fallback);
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };

/**
 * Pulls the reply's text out of the model's JSON as it streams in, so it can be
 * spoken before the JSON is finished. It reads JSON string escapes, including
 * one split across two chunks; the rest of the object is left to `readReply`.
 */
export class ReplyExtractor {
  private buffer = '';
  /** Where the next unread character of the reply is, once its opening quote is seen. */
  private at = -1;
  private closed = false;

  push(chunk: string): string {
    this.buffer += chunk;
    if (this.closed) return '';
    if (this.at < 0) {
      const opening = /"reply"\s*:\s*"/.exec(this.buffer);
      if (!opening) return '';
      this.at = opening.index + opening[0].length;
    }

    let text = '';
    while (this.at < this.buffer.length) {
      const c = this.buffer[this.at]!;
      if (c === '"') {
        this.closed = true;
        break;
      }
      if (c !== '\\') {
        text += c;
        this.at += 1;
        continue;
      }
      const escaped = this.buffer[this.at + 1];
      if (escaped === undefined) break;
      if (escaped === 'u') {
        const hex = this.buffer.slice(this.at + 2, this.at + 6);
        if (hex.length < 4) break;
        text += String.fromCharCode(parseInt(hex, 16));
        this.at += 6;
        continue;
      }
      text += ESCAPES[escaped] ?? escaped;
      this.at += 2;
    }
    return text;
  }
}

/**
 * One chat completion, streamed: `onDelta` gets each piece of the model's
 * output as it arrives, and the whole of it comes back at the end. Charging the
 * budget is left to the caller, which knows which allowance it is.
 */
export async function streamChat(
  request: { model: string; [key: string]: unknown },
  onDelta: (delta: string) => void,
): Promise<{ raw: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  return timed('answer_model', async () => {
    const response = await fetch(`${OPENAI}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`answer stream failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let pending = '';
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

    // Server-sent events: one `data: {...}` line per piece, `data: [DONE]` at the end.
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta?.content;
        if (!delta) continue;
        raw += delta;
        onDelta(delta);
      }
    }
    return { raw, usage };
  });
}

/**
 * The same answer, handed over a piece at a time as the model writes it.
 *
 * On a call the first sentence can be spoken while the rest is still being
 * written, and that wait was most of the silence after a question. `onText`
 * receives the reply as it arrives; the returned answer is the whole of it.
 */
export async function streamAnswer(
  tx: Db,
  tenantId: string,
  question: string,
  opts: AnswerOptions,
  onText: (text: string) => void,
): Promise<Answer> {
  const prepared = await prepareAnswer(tx, tenantId, question, opts);
  if ('ready' in prepared) {
    onText(prepared.ready.text);
    return prepared.ready;
  }

  const extractor = new ReplyExtractor();
  let spoke = false;
  const { raw, usage } = await streamChat(prepared.request, (delta) => {
    const text = extractor.push(delta);
    if (text) {
      spoke = true;
      onText(text);
    }
  });

  if (opts.budget) {
    void chargeBudget(opts.budget, prepared.request.model, {
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
    }).catch((error) => console.error('[budget] could not record the cost:', (error as Error).message));
  }

  const answer = readReply(raw, prepared.fallback);
  // Nothing could be read out as it arrived: say the whole answer, or the fallback, now.
  if (!spoke) onText(answer.text);
  return answer;
}

/** Looks up who is calling, so a caller only ever hears their own record. */
export async function employeeByNumber(tx: Db, tenantId: string, e164: string) {
  const digits = e164.replace(/[^\d]/g, '');
  return tx.query.employees.findFirst({
    // A deleted employee is nobody: the call is answered as an unknown number.
    where: and(eq(employees.tenantId, tenantId), eq(employees.mobileE164, digits), isNull(employees.deletedAt)),
  });
}
