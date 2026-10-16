import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { calls, cases, employees, messages } from '@/db/schema';
import { env } from '@/lib/env';
import { today } from '@/lib/dates';
import { assertBudget, BudgetExhausted, chargeBudget } from '@/lib/models/budget';
import { attendanceSummary, findPassages, openai, RELEVANCE_FLOOR, ReplyExtractor, streamChat, type Passage } from '@/lib/knowledge';
import { halfOfDay, MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { timed } from '@/lib/timing';
import { recordFollowUpChoice } from './follow-up-state';
import { dateLabel, formatDate, OPTIONS } from './flow';
import { instructionFor, OUTCOME_CODES, OUTCOMES, outcomeGuide, type LeaveChoice, type OutcomeCode } from './outcomes';
import { recordAnswer, UNANSWERED, type CaseRow, type EmployeeRow, type EngineContext } from './engine';
import { spokenDate } from './voice-script';

/**
 * The talking call, as a conversation rather than a script.
 *
 * Every sentence the agent says is written for that moment by the model: the
 * greeting, the questions, the answers, in the language the employee last
 * spoke. What the model may not do is decide what is recorded. It reports which
 * outcome of the customer's flow sheet it heard (`outcomes.ts`), the code checks
 * that against the sheet and writes it down, and what the employee is told to
 * do comes from the sheet too - the model only says it.
 *
 * One model call per turn, streamed: the reply is the second thing the model
 * writes, so the caller starts hearing it while the verdict is still being
 * written after it.
 */

export type TalkMode = 'first_contact' | 'follow_up' | 'inbound' | 'chat';

/** Whose allowance a turn spends: a WhatsApp chat is not a call. */
const budgetOf = (mode: TalkMode) => (mode === 'chat' ? ('whatsapp' as const) : ('call' as const));

/** Languages the voice can speak, as Sarvam names them. */
export const VOICE_LANGUAGES = ['en-IN', 'hi-IN', 'gu-IN', 'mr-IN', 'bn-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'od-IN'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export type TalkEvent = { type: 'lang'; language: VoiceLanguage } | { type: 'text'; text: string };
export type TalkResult = { done: boolean; nextCaseId: string | null; language: VoiceLanguage };
export type HistoryLine = { role: 'agent' | 'employee'; text: string };

type Action = 'continue' | 'handover' | 'end';

type Verdict = {
  reply_language: VoiceLanguage;
  reply: string;
  action: Action;
  outcome: OutcomeCode | 'none';
  leave_choice: LeaveChoice | 'not_said';
  follow_up: 'done' | 'not_done' | 'none';
  handover_reason: string | null;
  note: string | null;
};

/* ------------------------------------------------------------------ *
 * Grounding: the guidelines and the caller's own record
 * ------------------------------------------------------------------ */

export type Grounding = { passages: Passage[]; attendance: string };

/**
 * Searches the guidelines for what was said, and reads the caller's attendance.
 *
 * The search is the slow part of a turn, so the worker asks for it the moment
 * the caller stops talking, with the words heard so far, while the final
 * transcript is still being written - and the turn picks it up from here.
 */
export async function ground(
  tx: Db,
  tenantId: string,
  employeeId: string,
  said: string,
  budget: 'call' | 'whatsapp' = 'call',
): Promise<Grounding> {
  const [passages, attendance] = await Promise.all([
    said.trim() ? findPassages(tx, tenantId, said, 8, budget) : Promise.resolve([]),
    timed('attendance_db', () => attendanceSummary(tx, tenantId, employeeId)),
  ]);
  return { passages: passages.filter((p) => p.score >= RELEVANCE_FLOOR), attendance };
}

const PREPARED_TTL_MS = 15_000;
const prepared = new Map<string, { at: number; grounding: Promise<Grounding | null> }>();

/** Starts grounding a turn ahead of it. `key` is the call, or the number that rang in. */
export function prepareGrounding(key: string, work: () => Promise<Grounding | null>): void {
  for (const [k, v] of prepared) if (Date.now() - v.at > PREPARED_TTL_MS) prepared.delete(k);
  const grounding = work().catch((error) => {
    console.error('[talk] preparing a turn failed:', (error as Error).message);
    return null;
  });
  prepared.set(key, { at: Date.now(), grounding });
}

/** The grounding started for this turn, if there is a fresh one; it is used once. */
function takePrepared(key: string): Promise<Grounding | null> | null {
  const entry = prepared.get(key);
  prepared.delete(key);
  return entry && Date.now() - entry.at < PREPARED_TTL_MS ? entry.grounding : null;
}

/**
 * Whether what they said is only a thank-you or a goodbye, with nothing to
 * answer or look up.
 *
 * It decides one thing: whether the caller hears "Okay, let me check" while the
 * reply is written - which sounds silly after "thank you". It does not end the
 * call; the turn itself judges that from the words. Asked while the final
 * transcript is still being written, so it costs no time, and null when it
 * cannot say - the worker then falls back on its own word list.
 */
export async function onlyPleasantries(said: string): Promise<boolean | null> {
  try {
    await assertBudget('call');
    const json = await openai(
      '/chat/completions',
      {
        model: env.OPENAI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'An employee said this on a phone call with an HR assistant, in any language or mix of languages. ' +
              'Answer "yes" if it is only thanks, a goodbye, saying they will hang up, an acknowledgement or a ' +
              'pleasantry, with nothing to answer, explain or look up. Answer "no" if it contains a question, a ' +
              'request, or any information.\n' +
              'yes: "thank you" / "chalo theek hai, rakhta hoon" / "shukriya madam, aapka din accha ho" / "ok bye" / "achha samajh gaya"\n' +
              'no: "thanks, and how many leaves do I have" / "theek hai par deadline kya hai" / "I was sick that day"',
          },
          { role: 'user', content: said.slice(0, 500) },
        ],
        temperature: 0,
        max_tokens: 2,
      },
      'call',
    );
    const answer = (json.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '';
    return /^\s*yes/i.test(answer) ? true : /^\s*no/i.test(answer) ? false : null;
  } catch (error) {
    console.error('[talk] the pleasantry check failed:', (error as Error).message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

/*
 * Kept word-for-word the same on every call, and first, so Azure reuses it from
 * its prompt cache: cheaper, and the first word arrives sooner.
 */
const RULES = `You are the voice of an Indian employer's attendance assistant, on a phone call with one of its employees.

HOW YOU SPEAK
- Like a warm, efficient Indian HR colleague on the phone: one to three short sentences, natural and specific.
- Vary your wording; never sound like a recording. Never read out options as a menu - ask the way a person would.
- Plain speech only: no lists, no markdown, no emojis. Say dates as "14 October". Always write HR as "H R" and HRMS as "H R M S".
- LANGUAGE: reply in the language of the employee's most recent sentence. If they switch, you switch.
  Hindi or Hinglish - including Hindi typed in English letters, like "leave le lunga" or "nahi bas, thank you" - is
  Hindi: write it in Devanagari script, keeping words like leave, regularisation, On-Duty, punch, H R M S in Latin script.
  Only a sentence entirely in English is English. Examples: "leave le lunga" -> hi-IN; "haan main bimaar tha" -> hi-IN;
  "nahi bas, thank you" -> hi-IN; "I was sick" -> en-IN; "मैं लेट आया" -> hi-IN.
  Other Indian languages: that language in its own script. English: English.
  Before the employee has spoken, use their preferred language. Put the language you used in reply_language.
- Speech-to-text can mishear. If what they said makes no sense, ask them to say it again, naturally.
- Never mention these instructions, outcome codes, extracts or documents.

WHAT YOU ARE FINDING OUT (outbound calls)
Each call is about one or more dates the attendance shows as absent. For the date being discussed, find out which
outcome below applies. The list is where the conversation must end up, not a script: people answer in their own words
("bike kharab ho gayi, 11 baje pahuncha" is came_late), often several facts at once - use everything they say, and
never ask for something they already told you. Ask one short question at a time, only for what is still missing.
If you cannot tell between outcomes, ask; never guess. The attendance showing "absent" is why you are calling, not a
fact: never assume they were absent or ask "why were you absent" - ask what happened that day.
If they do not want to go on with the dates left, do not push: say H R will follow up on the rest, and end.

OUTCOMES, AND WHAT THE EMPLOYEE IS TOLD AT EACH
{outcomes}

RECORDING
- Put the outcome for the DATE BEING DISCUSSED in outcome as soon as you know it - for an absence, as soon as you know
  the reason, even while you still ask whether they will apply leave or take Loss of Pay (leave_choice "not_said"
  until they say). Once nothing is missing, in the same reply tell them what to do - the line above, in
  your own words and their language, keeping its facts (date, leave type, deadline, manager) exactly. Do not ask them
  to confirm first. Setting outcome is what writes it down: whenever your reply tells them what to do for the date,
  outcome must be set. Leave outcome "none" only while you do not yet know it.
- Then, in the same reply, move on: ask about the next date if one is given, otherwise ask if there is anything else.
- If they correct something already noted, set the corrected outcome.
- For an absence, ask what happened if they have not said, and ask whether they will apply leave or take it as Loss of
  Pay. Do not push either way.

REMINDER CALLS
On a reminder call, ask whether they have done what they were told last time. Set follow_up "done" or "not_done"
once they say. If not done, remind them kindly of what to do. Then the next date, if any.

QUESTIONS
If they ask something, answer it from the POLICY EXTRACTS and ATTENDANCE given, and nothing else, then come back to the
date. If they genuinely do not cover it, simply say H R will come back to them on that. Never guess a number, a deadline, an
entitlement or a process. Never mention another employee.

HANDING OVER (action "handover", with a short handover_reason)
They ask for a person or H R, are upset or refuse, cannot talk now or ask to be called later, say it is the wrong
person, or ask not to be called. Say kindly that someone from H R will contact them, and goodbye.

ENDING (action "end")
They say goodbye, or thank you with nothing more, and nothing is left to ask - or everything is done and they have
nothing else. The reply is then a short, warm goodbye and never a question, because the call ends after it.
Somebody who thanks you and then asks something is not finished.

Otherwise action is "continue". note: the reason in their own words, in English, when they gave one; otherwise null.`;

const SYSTEM = RULES.replace('{outcomes}', outcomeGuide());

/** The same conversation, written on WhatsApp. */
export const CHAT_SYSTEM = SYSTEM.replace('on a phone call with one of its employees', 'in a WhatsApp chat with one of its employees')
  .replace(
    /HOW YOU SPEAK\n[\s\S]*?(?=- LANGUAGE:)/,
    `HOW YOU WRITE
- Like a warm, efficient Indian HR colleague on WhatsApp: short plain messages, one to three sentences, specific.
- Vary your wording; never sound like a form letter. They can also tap menu options; you never need to list them.
- No markdown headings, no emojis. Write dates as given. Write HR and HRMS as they are.
`,
  )
  .replace(/- Speech-to-text can mishear\.[^\n]*\n/, '')
  .replace(
    '- Then, in the same reply, move on: ask about the next date if one is given, otherwise ask if there is anything else.',
    '- Do not ask about any other date: the next one is sent to them separately once this one is settled.',
  )
  .replace('because the call ends after it', 'because the chat is finished');

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'turn',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      // The reply comes second, straight after its language, so it can be
      // spoken while the verdict after it is still being written.
      required: ['reply_language', 'reply', 'action', 'outcome', 'leave_choice', 'follow_up', 'handover_reason', 'note'],
      properties: {
        reply_language: {
          type: 'string',
          enum: [...VOICE_LANGUAGES],
          description:
            "The language of the employee's most recent sentence, which is the language you reply in. Hindi written in English letters is hi-IN.",
        },
        reply: { type: 'string', description: 'What to say out loud' },
        action: { type: 'string', enum: ['continue', 'handover', 'end'] },
        outcome: { type: 'string', enum: [...OUTCOME_CODES, 'none'] },
        leave_choice: { type: 'string', enum: ['leave', 'loss_of_pay', 'not_said'] },
        follow_up: { type: 'string', enum: ['done', 'not_done', 'none'] },
        handover_reason: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
      },
    },
  },
};

const LANGUAGE_NAMES: Record<string, VoiceLanguage> = {
  en: 'en-IN', hi: 'hi-IN', gu: 'gu-IN', mr: 'mr-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', pa: 'pa-IN', or: 'od-IN', od: 'od-IN',
};

export function voiceLanguage(code: string | null | undefined): VoiceLanguage {
  const short = (code ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en';
  return LANGUAGE_NAMES[short] ?? 'en-IN';
}

/** Scripts that name their language outright. Devanagari is Hindi unless the employee is set to Marathi. */
const SCRIPTS: [RegExp, VoiceLanguage][] = [
  [/[\u0900-\u097F]/, 'hi-IN'],
  [/[\u0980-\u09FF]/, 'bn-IN'],
  [/[\u0A00-\u0A7F]/, 'pa-IN'],
  [/[\u0A80-\u0AFF]/, 'gu-IN'],
  [/[\u0B00-\u0B7F]/, 'od-IN'],
  [/[\u0B80-\u0BFF]/, 'ta-IN'],
  [/[\u0C00-\u0C7F]/, 'te-IN'],
  [/[\u0C80-\u0CFF]/, 'kn-IN'],
  [/[\u0D00-\u0D7F]/, 'ml-IN'],
];

/** Hindi words people type or are transcribed saying in English letters, none of them also English words. */
const HINGLISH = new Set(
  ('hai hain tha thi the nahi nahin haan han ha ji kya kyun kaise kitna kitni kitne mera meri mere mujhe mujhko hum ' +
    'humne aap aapka aapki maine tum kar karo karna karunga karungi kiya kiye gaya gayi gaye raha rahi rahe hoon hu ' +
    'lunga lungi lenge dunga bas theek thik accha acha achha bhai bimaar bimar ghar kaam chutti aaj kal parso abhi ' +
    'matlab wala wali waala sab kuch koi phir fir lekin aur ya toh bhi nhi pata bata batao bolo boliye haanji ' +
    'ko ka ki ke se le de mein ').split(/\s+/).filter(Boolean),
);

/**
 * The language of what they just said, decided here rather than left to the
 * model, which kept answering Hindi typed in English letters in English.
 */
export function spokenLanguage(said: string, preferred: VoiceLanguage): VoiceLanguage {
  for (const [script, language] of SCRIPTS) {
    if (script.test(said)) return language === 'hi-IN' && preferred === 'mr-IN' ? 'mr-IN' : language;
  }
  const words = said.toLowerCase().match(/[a-z]+/g) ?? [];
  const hindi = words.filter((w) => HINGLISH.has(w)).length;
  return hindi >= 2 || (hindi >= 1 && words.length <= 3) ? 'hi-IN' : 'en-IN';
}

const spokenFor = (row: { attDate: string; meaning: string }) =>
  spokenDate(row.attDate, halfOfDay(row.meaning as Meaning) as 'first' | 'second' | null);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type TalkContext = EngineContext & { companyName: string };

type Situation = {
  mode: TalkMode;
  employee: EmployeeRow;
  caseRow: CaseRow | null;
  /** Other dates still to cover on this call, oldest first. */
  upcoming: CaseRow[];
  manager: string | null;
  history: HistoryLine[];
  said: string | null;
  grounding: Grounding | null;
  /** On WhatsApp: where they are in the menus, if part-way through. */
  menu?: string | null;
};

function describe(ctx: TalkContext, s: Situation): string {
  const now = today(ctx.settings.timezone);
  const chat = s.mode === 'chat';
  // Spoken dates on a call, the dates as WhatsApp messages write them in a chat.
  const dateOf = (row: CaseRow) => (chat ? dateLabel(row.attDate, row.meaning as Meaning) : spokenFor(row));
  const deadline = chat
    ? formatDate(addDays(now, ctx.settings.followUpAfterDays))
    : spokenDate(addDays(now, ctx.settings.followUpAfterDays));
  const lines: string[] = [];

  lines.push(`TODAY: ${spokenDate(now)}, ${WEEKDAYS[new Date(`${now}T00:00:00Z`).getUTCDay()]}`);
  lines.push(`EMPLOYEE: ${s.employee.fullName} (call them ${s.employee.fullName.split(/\s+/)[0]}), works at ${ctx.companyName}`);
  lines.push(`PREFERRED LANGUAGE: ${voiceLanguage(s.employee.language ?? ctx.settings.defaultLanguage)}`);
  lines.push(
    chat
      ? 'THIS CONVERSATION: a WhatsApp chat about attendance. They may tap menu options or type.'
      : s.mode === 'inbound'
      ? 'THIS CALL: they rang us. Help with whatever they ask; there are no dates to go through.'
      : s.mode === 'follow_up'
        ? 'THIS CALL: a reminder call we placed.'
        : 'THIS CALL: we called them about attendance.',
  );

  if (s.caseRow && s.mode !== 'inbound') {
    const meaning = MEANING_LABELS[s.caseRow.meaning as Meaning] ?? s.caseRow.meaning;
    lines.push(`DATE BEING DISCUSSED: ${dateOf(s.caseRow)} (attendance shows: ${meaning})`);
    if (s.menu) lines.push(`WHERE THEY ARE IN THE MENUS: ${s.menu}`);
    const noted = (s.caseRow.context as { outcome?: { code: OutcomeCode; leaveChoice: LeaveChoice | null } }).outcome;
    if (s.mode === 'follow_up' && noted) {
      const told = instructionFor(noted.code, noted.leaveChoice, { date: dateOf(s.caseRow), deadline, manager: s.manager });
      lines.push(`LAST TIME: they said ${OUTCOMES[noted.code].label.toLowerCase()}, and were told: "${told}"`);
    } else if (s.mode === 'follow_up' && s.caseRow.replyOption) {
      const option = OPTIONS[s.caseRow.replyOption as 1 | 2 | 3 | 4];
      lines.push(`LAST TIME: they said "${option.label}", and were asked to: ${option.action.toLowerCase()}`);
    } else if (noted) {
      lines.push(`ALREADY NOTED FOR THIS DATE: ${noted.code}${noted.leaveChoice ? ` (${noted.leaveChoice})` : ''}`);
    }
    if (!chat) {
      lines.push(
        s.upcoming.length
          ? `NEXT DATES, OLDEST FIRST, AFTER THIS ONE: ${s.upcoming.map(spokenFor).join(', ')}`
          : 'NO OTHER DATES after this one.',
      );
    }
    lines.push(`FACTS FOR WHAT THEY ARE TOLD: date "${dateOf(s.caseRow)}", deadline "${deadline}", manager "${s.manager ?? 'your manager'}"`);
  }

  if (s.grounding?.passages.length) {
    lines.push('', `POLICY EXTRACTS\n${s.grounding.passages.map((p) => `[${p.title}] ${p.text}`).join('\n\n')}`);
  }
  if (s.grounding?.attendance) lines.push('', `ATTENDANCE\n${s.grounding.attendance}`);

  lines.push('', 'CONVERSATION SO FAR');
  lines.push(...(s.history.length ? s.history.slice(-14).map((h) => `${h.role === 'agent' ? 'You' : 'Employee'}: ${h.text}`) : ['(nothing yet)']));
  if (chat) {
    lines.push('', `THEY JUST WROTE: "${s.said ?? ''}"\nREPLY IN: ${spokenLanguage(s.said ?? '', voiceLanguage(s.employee.language ?? ctx.settings.defaultLanguage))} (the language of what they just wrote)`);
    return lines.join('\n');
  }
  const preferred = voiceLanguage(s.employee.language ?? ctx.settings.defaultLanguage);
  lines.push(
    '',
    s.said === null
      ? `The call has just been answered and they have greeted you. Open the call: say who you are and why you are calling, then ask your first question. REPLY IN: ${preferred}`
      : `THEY JUST SAID: "${s.said}"\nREPLY IN: ${spokenLanguage(s.said, preferred)} (the language of what they just said)`,
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * One turn
 * ------------------------------------------------------------------ */

export type TalkArgs = {
  mode: TalkMode;
  employee: EmployeeRow;
  /** The call this is, when we placed it; inbound calls have none. */
  call: typeof calls.$inferSelect | null;
  /** The date being discussed. */
  caseRow: CaseRow | null;
  /** Null opens the call. */
  said: string | null;
  /** For an inbound call, which keeps no transcript here: what has been said so far. */
  history?: HistoryLine[];
  /** Where a grounding started ahead of this turn would be. */
  preparedKey?: string;
  /** Tests stand in for the model. */
  model?: (request: { model: string; [key: string]: unknown }, onDelta: (delta: string) => void) => ReturnType<typeof streamChat>;
};

const HANDOVER_LINE = 'Sorry, I am not able to continue this call right now. Someone from H R will contact you. Goodbye.';
const LANGUAGE_FIELD = /"reply_language"\s*:\s*"([a-z]{2}-[A-Z]{2})"/;

export async function talkTurn(ctx: TalkContext, args: TalkArgs, onEvent: (event: TalkEvent) => void): Promise<TalkResult> {
  const { employee, call, mode } = args;
  const caseRow = args.caseRow;
  const fallbackLanguage = voiceLanguage(employee.language ?? ctx.settings.defaultLanguage);

  if (call && args.said !== null) await appendLine(ctx.tx, call.id, 'employee', args.said || '(silence)');

  const giveUp = async (reason: string): Promise<TalkResult> => {
    onEvent({ type: 'lang', language: 'en-IN' });
    onEvent({ type: 'text', text: HANDOVER_LINE });
    await handOver(ctx, args, reason);
    return { done: true, nextCaseId: null, language: 'en-IN' };
  };

  try {
    await assertBudget(budgetOf(mode));
  } catch (error) {
    if (error instanceof BudgetExhausted) return giveUp('The AI allowance for calls is used up');
    throw error;
  }

  const [upcoming, manager, grounding] = await Promise.all([
    caseRow && mode !== 'inbound' ? remainingDates(ctx, employee.id, mode, caseRow.id) : Promise.resolve([]),
    managerName(ctx.tx, employee),
    args.said === null
      ? Promise.resolve(null)
      : ((args.preparedKey ? takePrepared(args.preparedKey) : null) ?? ground(ctx.tx, ctx.tenantId, employee.id, args.said)),
  ]);

  const history: HistoryLine[] = call
    ? (call.transcript ?? []).map((t) => ({ role: t.role, text: t.text }))
    : (args.history ?? []);

  const request = {
    model: env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: describe(ctx, { mode, employee, caseRow, upcoming, manager, history, said: args.said, grounding }),
      },
    ],
    temperature: 0.6,
    max_tokens: 400,
    response_format: SCHEMA,
  };

  const extractor = new ReplyExtractor();
  let language: VoiceLanguage | null = null;
  let buffer = '';
  let spoke = '';
  let raw: string;
  try {
    const result = await (args.model ?? streamChat)(request, (delta) => {
      buffer += delta;
      if (!language) {
        const found = LANGUAGE_FIELD.exec(buffer)?.[1] as VoiceLanguage | undefined;
        if (!found) return;
        language = VOICE_LANGUAGES.includes(found) ? found : 'en-IN';
        onEvent({ type: 'lang', language });
      }
      const text = extractor.push(delta);
      if (text) {
        spoke += text;
        onEvent({ type: 'text', text });
      }
    });
    raw = result.raw;
    void chargeBudget(budgetOf(mode), request.model, {
      inputTokens: result.usage?.prompt_tokens,
      outputTokens: result.usage?.completion_tokens,
    }).catch((error) => console.error('[budget] could not record the cost:', (error as Error).message));
  } catch (error) {
    console.error('[talk] the model failed:', (error as Error).message);
    if (spoke) return { done: false, nextCaseId: caseRow?.id ?? null, language: language ?? fallbackLanguage };
    return giveUp('The conversation model failed');
  }

  let verdict: Verdict;
  try {
    verdict = JSON.parse(raw) as Verdict;
  } catch {
    // Whatever was said stands; nothing is recorded from a verdict nobody can read.
    if (!spoke) return giveUp('The conversation model gave an unreadable answer');
    return { done: false, nextCaseId: caseRow?.id ?? null, language: language ?? fallbackLanguage };
  }

  // The language came first in the JSON, so it is normally already out.
  if (!language) {
    language = VOICE_LANGUAGES.includes(verdict.reply_language) ? verdict.reply_language : fallbackLanguage;
    onEvent({ type: 'lang', language });
  }
  if (!spoke && verdict.reply?.trim()) {
    spoke = verdict.reply.trim();
    onEvent({ type: 'text', text: spoke });
  }
  if (call) await appendLine(ctx.tx, call.id, 'agent', spoke);

  const result = await apply(ctx, args, verdict, upcoming, manager);
  return { ...result, language };
}

/** What a chat turn came to, for the WhatsApp engine to act on. */
export type ChatVerdict = {
  reply: string;
  outcome: OutcomeCode | null;
  leaveChoice: LeaveChoice | null;
  note: string | null;
  action: Action;
  handoverReason: string | null;
};

/**
 * One typed WhatsApp message about a date, answered by the same conversation as
 * a call, written instead of spoken. Nothing is recorded here: the engine owns
 * WhatsApp's state - menus, the backlog chain, the window - and acts on the
 * verdict. Null when the model could not be asked or could not be read.
 */
export async function chatTurn(
  ctx: TalkContext,
  args: {
    employee: EmployeeRow;
    caseRow: CaseRow;
    said: string;
    history: HistoryLine[];
    menu?: string | null;
    model?: TalkArgs['model'];
  },
): Promise<ChatVerdict | null> {
  try {
    await assertBudget('whatsapp');
  } catch (error) {
    if (error instanceof BudgetExhausted) return null;
    throw error;
  }

  const manager = await managerName(ctx.tx, args.employee);
  // A savepoint, so a failed search cannot abort the message's own transaction.
  const grounding = await ctx.tx
    .transaction((tx) => ground(tx, ctx.tenantId, args.employee.id, args.said, 'whatsapp'))
    .catch((error) => {
      console.error('[talk] the guideline search failed:', (error as Error).message);
      return null;
    });

  const request = {
    model: env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: CHAT_SYSTEM },
      {
        role: 'user',
        content: describe(ctx, {
          mode: 'chat',
          employee: args.employee,
          caseRow: args.caseRow,
          upcoming: [],
          manager,
          history: args.history,
          said: args.said,
          grounding,
          menu: args.menu,
        }),
      },
    ],
    temperature: 0.6,
    max_tokens: 400,
    response_format: SCHEMA,
  };

  try {
    const result = await (args.model ?? streamChat)(request, () => {});
    void chargeBudget('whatsapp', request.model, {
      inputTokens: result.usage?.prompt_tokens,
      outputTokens: result.usage?.completion_tokens,
    }).catch((error) => console.error('[budget] could not record the cost:', (error as Error).message));
    const verdict = JSON.parse(result.raw) as Verdict;
    if (!verdict.reply?.trim()) return null;
    const outcome = verdict.outcome !== 'none' && OUTCOMES[verdict.outcome] ? verdict.outcome : null;
    return {
      reply: verdict.reply.trim(),
      outcome,
      leaveChoice: verdict.leave_choice === 'not_said' ? null : verdict.leave_choice,
      note: verdict.note,
      action: verdict.action,
      handoverReason: verdict.handover_reason,
    };
  } catch (error) {
    console.error('[talk] a chat turn failed:', (error as Error).message);
    return null;
  }
}

/** What the turn changes: a recorded outcome, a reminder answered, a handover, the end. */
async function apply(
  ctx: TalkContext,
  args: TalkArgs,
  verdict: Verdict,
  upcoming: CaseRow[],
  manager: string | null,
): Promise<Omit<TalkResult, 'language'>> {
  const { mode, caseRow, call } = args;

  if (verdict.action === 'handover') {
    await handOver(ctx, args, verdict.handover_reason || 'Asked for H R on the call');
    return { done: true, nextCaseId: null };
  }

  // What was settled for the date, whatever else the turn does: a goodbye can
  // carry the last answer with it.
  let next = caseRow?.id ?? null;
  if (caseRow && mode === 'first_contact' && verdict.outcome !== 'none') {
    const outcome = OUTCOMES[verdict.outcome];
    const choice = verdict.leave_choice === 'not_said' ? null : verdict.leave_choice;
    // An absence is not settled until they have said leave or Loss of Pay.
    if (outcome && !(outcome.asksLeaveOrLossOfPay && !choice)) {
      await recordOutcome(ctx, caseRow, args.employee, verdict.outcome, choice, verdict.note, manager);
      next = upcoming[0]?.id ?? caseRow.id;
    }
  }
  if (caseRow && mode === 'follow_up' && verdict.follow_up !== 'none') {
    const fresh = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) });
    if (fresh?.status === 'answered' && !fresh.followUpReply) {
      await recordFollowUpChoice(ctx, fresh, verdict.follow_up);
      await mirror(ctx.tx, ctx.tenantId, caseRow, args.employee, `Answered the reminder on the call: ${verdict.follow_up.replace('_', ' ')}`, null);
    }
    next = upcoming[0]?.id ?? caseRow.id;
  }

  if (verdict.action === 'end') {
    if (call) {
      const left = await remainingDates(ctx, args.employee.id, mode === 'follow_up' ? 'follow_up' : 'first_contact');
      await finishCall(ctx.tx, call.id, left.length ? 'not_completed' : 'completed_confirmed');
    }
    return { done: true, nextCaseId: null };
  }

  return { done: false, nextCaseId: mode === 'inbound' ? null : next };
}

/** Writes down what was heard, with what they were told to do. */
export async function recordOutcome(
  ctx: TalkContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  code: OutcomeCode,
  choice: LeaveChoice | null,
  note: string | null,
  manager: string | null,
  via: 'call' | 'whatsapp' = 'call',
) {
  const outcome = OUTCOMES[code];
  const option = outcome.option;
  await recordAnswer(ctx, caseRow, option, {
    intent: OPTIONS[option].intent,
    option,
    confidence: 1,
    source: 'model',
    reason: note,
  });

  const lossOfPay = outcome.asksLeaveOrLossOfPay && choice === 'loss_of_pay';
  const at = new Date();
  const label = choice === 'loss_of_pay' ? `${outcome.label} - Loss of Pay` : outcome.label;
  await ctx.tx
    .update(cases)
    .set({
      replyText: note ? `${label}: ${note}` : label,
      context: { ...(caseRow.context ?? {}), outcome: { code, leaveChoice: choice, note, at: at.toISOString(), via } },
      // Nothing to chase: Loss of Pay is settled, and a handover is HR's now.
      ...(lossOfPay
        ? { status: 'resolved' as const, resolvedAt: at, closeReason: 'Employee chose Loss of Pay', followUpDueAt: null, callDueAt: null }
        : {}),
      ...(outcome.handover
        ? { status: 'needs_hr' as const, needsHrReason: outcome.handover, followUpDueAt: null, callDueAt: null }
        : {}),
      updatedAt: at,
    })
    .where(eq(cases.id, caseRow.id));

  // A chat is already in the message history; only a call needs writing into it.
  if (via === 'whatsapp') return;
  const deadline = spokenDate(addDays(today(ctx.settings.timezone), ctx.settings.followUpAfterDays));
  const told = instructionFor(code, choice, { date: spokenFor(caseRow), deadline, manager });
  await mirror(ctx.tx, ctx.tenantId, caseRow, employee, `Said on the call: ${label}${note ? ` (${note})` : ''}`, told);
}

async function handOver(ctx: TalkContext, args: TalkArgs, reason: string) {
  const { caseRow, call, mode } = args;
  if (caseRow && mode === 'follow_up') {
    const fresh = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) });
    if (fresh?.status === 'answered') await recordFollowUpChoice(ctx, fresh, 'help');
  } else if (caseRow && mode === 'first_contact') {
    await ctx.tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: reason.slice(0, 300), updatedAt: new Date() })
      .where(and(eq(cases.id, caseRow.id), inArray(cases.status, [...UNANSWERED])));
  }
  if (call) await finishCall(ctx.tx, call.id, 'needs_help');
}

/** The dates still to cover after this one, oldest first. */
async function remainingDates(ctx: TalkContext, employeeId: string, mode: TalkMode, excludeCaseId?: string) {
  const exclude = excludeCaseId ? sql`${cases.id} <> ${excludeCaseId}` : sql`true`;
  const which =
    mode === 'follow_up'
      ? and(eq(cases.status, 'answered'), sql`${cases.replyOption} is not null`, sql`${cases.followUpReply} is null`)
      : inArray(cases.status, [...UNANSWERED]);
  return ctx.tx
    .select()
    .from(cases)
    .where(and(eq(cases.employeeId, employeeId), which, exclude))
    .orderBy(asc(cases.attDate));
}

async function managerName(tx: Db, employee: EmployeeRow): Promise<string | null> {
  if (!employee.managerEmployeeId) return null;
  const manager = await tx.query.employees.findFirst({
    where: eq(employees.id, employee.managerEmployeeId),
    columns: { fullName: true },
  });
  return manager?.fullName.split(/\s+/)[0] ?? null;
}

async function appendLine(tx: Db, callId: string, role: 'agent' | 'employee', text: string) {
  await tx
    .update(calls)
    .set({
      transcript: sql`coalesce(${calls.transcript}, '[]'::jsonb) || ${JSON.stringify([{ role, text, at: new Date().toISOString() }])}::jsonb`,
    })
    .where(eq(calls.id, callId));
}

async function finishCall(tx: Db, callId: string, outcome: 'completed_confirmed' | 'not_completed' | 'needs_help') {
  await tx.update(calls).set({ status: 'completed', outcome, endedAt: new Date() }).where(eq(calls.id, callId));
}

/** Mirrors the call into the case's message history, so HR reads one story. */
async function mirror(tx: Db, tenantId: string, caseRow: CaseRow, employee: EmployeeRow, heard: string, told: string | null) {
  const base = { tenantId, caseId: caseRow.id, channel: 'voice' as const, kind: 'voice' as const, waId: employee.mobileE164 };
  await tx.insert(messages).values([
    { ...base, direction: 'inbound' as const, status: 'received' as const, body: heard },
    ...(told ? [{ ...base, direction: 'outbound' as const, status: 'sent' as const, body: told }] : []),
  ]);
}
