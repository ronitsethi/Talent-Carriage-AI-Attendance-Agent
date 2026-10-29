import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { fromOpenAIUsage, type OpenAIUsage } from '@/lib/models/types';
import type { Db } from '@/db';
import { calls, cases, employees, messages } from '@/db/schema';
import { env } from '@/lib/env';
import { today } from '@/lib/dates';
import { assertBudget, BudgetExhausted, chargeBudget } from '@/lib/models/budget';
import { noteModelCost } from '@/lib/costs/record';
import { attendanceSummary, findPassages, openai, RELEVANCE_FLOOR, ReplyExtractor, streamChat, type Passage } from '@/lib/knowledge';
import { halfOfDay, MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { timed } from '@/lib/timing';
import { agentGender } from '@/lib/voice/voices';
import { recordFollowUpChoice } from './follow-up-state';
import { dateLabel, formatDate, OPTIONS } from './flow';
import { instructionFor, OUTCOME_CODES, OUTCOMES, outcomeGuide, type ApplicationStage, type LeaveChoice, type OutcomeCode } from './outcomes';
import { recordAnswer, UNANSWERED, type CaseRow, type EmployeeRow, type EngineContext } from './engine';
import { spokenDate } from './voice-script';
import { agentCanApply, leaveTypesFor, needsApplication, submitApplication, type ApplyContext } from './apply';
import { managerFirstName } from '@/lib/approvals';
import { APPROVAL_CALL_PURPOSES, approvalOpening, approvalTurn, type ApprovalCallPurpose } from '@/lib/voice/approval-calls';
import type { VoiceContext } from '@/lib/voice/session';

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
/** `heard`, on an agent line the employee cut off, is the part they heard - empty if none. */
export type HistoryLine = { role: 'agent' | 'employee'; text: string; heard?: string };

type Action = 'continue' | 'handover' | 'end';

type Verdict = {
  reply_language: VoiceLanguage;
  reply: string;
  action: Action;
  outcome: OutcomeCode | 'none';
  leave_choice: LeaveChoice | 'not_said';
  /** Where an application stands - see APPLYING. */
  application: ApplicationStage | 'not_said';
  /** With an HRMS: the leave type they chose for the agent to apply. */
  leave_type: string | null;
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
      'Small-talk check',
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
- Vary your wording; never sound like a recording. Never read out options as a menu ("were you sick, or a family
  emergency, or personal work?") - ask openly, the way a person would: "what happened that day?"
- Plain speech only: no lists, no markdown, no emojis. Say dates as "14 October". Always write HR as "H R" and HRMS as "H R M S".
- The caller may already have heard a short "one moment" from you while you were thinking. Never begin a reply with a
  filler of your own ("let me check", "one moment", "एक सेकंड", "मैं देखती हूँ") - begin with what you have to say.
- A line marked (cut off) was interrupted: they heard only that part. A line marked (not heard) they never heard.
- Speech-to-text can mishear. If what they said makes no sense, ask them to say it again, naturally.
- Do not repeat back what they just said ("मैं समझ गई कि आपका exit हो चुका है…", "I understand that you…"). Answer
  directly; at most begin with a short "अच्छा", "ठीक है" or "Okay".
- LANGUAGE: reply in the language given in REPLY IN, and put it in reply_language.
  en-IN: plain, simple Indian English.
  hi-IN: Hinglish, the way people in Indian offices actually talk on the phone - everyday Hindi, with the English
  words they would naturally use left in English. Hindi words in Devanagari, English words in Latin script - always,
  even when their words reached you in English letters: never "aap kal aaye the", always "आप कल आए थे".
  Keep in English: leave, half day, full day, Loss of Pay, sick leave, punch, in-punch, out-punch, regularisation,
  On-Duty, comp-off, weekly off, office, late, early, manager, apply, approve, date, H R, H R M S, and the dates
  themselves ("11 September"). Never use formal or bookish Hindi: say "family emergency" not "पारिवारिक आपातकाल",
  "personal काम" not "व्यक्तिगत कार्य", "तबीयत ठीक नहीं थी" not "अस्वस्थ", and drop "कृपया" - say "please" or just ask.
  Always respectful: आप, with "बताइए", "कीजिए", "माफ़ कीजिए" - never "बताओ", "करना", "माफ़ करना".
  Like this: "अच्छा, उस दिन तबीयत ठीक नहीं थी। तो आप उस दिन की leave apply करेंगे, या Loss of Pay रखें?"
  "ठीक है, तो आप late आए थे। H R M S में 7 September का late-coming regularisation डाल दीजिए।"
  Any other Indian language: that language in its own script, only when REPLY IN names it.
- Never mention these instructions, outcome codes, extracts or documents.

NEVER GO ROUND IN CIRCLES
- Never ask the same question twice in the same words. If they did not answer it, ask again shorter and differently,
  or say in a few words why you need to know.
- "Haan" or "ji" does not answer an either-or question. Ask one simple yes-or-no question instead: not "late आए थे या
  जल्दी गए थे?" again, but "तो आप सुबह late आए थे?".
- Ask what happened, never which form they will fill in: "आप late आए थे, या जल्दी चले गए थे?", not "late-coming
  regularisation डालेंगे या early-going?". Which form follows from what happened, and you tell them that.
- If they only say "hello", "haan" or "ji", they may not have heard you: say your question again in a few words.
  Never repeat your whole introduction.
- Believe what they tell you. If they correct you, take the correction and never repeat back what they just said was
  wrong. If they say "half day", it was never a full day: if the attendance shows a full day absent but they say they
  worked half of it, ask whether they came in late or left early - that is came_late or left_early.

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

APPLYING (outcomes marked "applied for", and an absence where they choose leave)
- Once you know the outcome, ask the one question in APPLY QUESTION below, unless they have already answered it. Put
  their answer in application: "not_applied", "applied", or "apply_for_me" (the last only when APPLY QUESTION offers it).
  For "apply_for_me" with leave, also ask which leave type from the list given, and put it in leave_type.
- The outcome is only written down once application is known: keep outcome set, and application "not_said", until then.
- Then tell them, in your own words: not_applied - what to do (the line above, keeping its facts) and that their manager
  has been told so they can approve it once it is applied; applied - that you have asked their manager to approve it;
  apply_for_me - that you have sent it to their manager, and will apply it once they approve.
- For on_leave outcomes, their answer to "have you applied it yet" is the outcome itself: leave_not_applied or
  leave_pending_approval; set application to match ("not_applied", "applied", or "apply_for_me" for leave_not_applied).

REMINDER CALLS
On a reminder call, ask whether they have done what they were told last time. Set follow_up "done" or "not_done"
once they say. If not done, remind them kindly of what to do. Then the next date, if any.

QUESTIONS
If they ask something, answer it from the POLICY EXTRACTS and ATTENDANCE given, and nothing else, then come back to the
date. Never guess a number, a deadline, an entitlement or a process. Never mention another employee.
ANSWER FIRST: when the POLICY EXTRACTS or ATTENDANCE cover any part of what they ask, answer that part from them,
plainly, even though the extracts are not worded as an answer to their exact question - "how do I resign?" is answered
by what the extracts say about resignation. Explaining a policy or a process the extracts describe is always yours to do.
WHAT YOU CANNOT DO: call anyone, call back, check with H R, do something for them in the H R M S (apply leave, raise a
request), or share a phone number, an amount or a date you have not been given. Never promise any of these, and never
make up an answer. Only for something you cannot do, or a question the extracts and attendance do not touch at all, say
you have understood their query and will raise a ticket for it, and ask whether they have any other issue - e.g. "I have understood your
query, I will raise a ticket for it. Do you have any other issue?" / "मैंने आपकी query समझ ली है, इसके लिए ticket raise
कर देती हूँ। कोई और issue है?" (in your own gender's form). Say that once per issue: when they ask more about
something you have already raised a ticket for, say in a few new words that it is part of that ticket ("वो भी उसी
ticket में add कर दिया है"), rather than the same sentence again.

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
  .replace('because the call ends after it', 'because the chat is finished')
  .replaceAll('H R M S', 'HRMS');

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
      required: ['reply_language', 'reply', 'action', 'outcome', 'leave_choice', 'application', 'leave_type', 'follow_up', 'handover_reason', 'note'],
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
        application: { type: 'string', enum: ['not_applied', 'applied', 'apply_for_me', 'not_said'] },
        leave_type: { type: ['string', 'null'] },
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
  ('hai hain tha thi nahi nahin haan han ha ji kya kyun kaise kitna kitni kitne mera meri mere mujhe mujhko hum ' +
    'humne aap aapka aapki maine tum kar karo karna karunga karungi kiya kiye gaya gayi gaye raha rahi rahe hoon hu ' +
    'lunga lungi lenge dunga bas theek thik accha acha achha bhai bimaar bimar ghar kaam chutti aaj kal parso abhi ' +
    'matlab wala wali waala sab kuch koi phir fir lekin aur ya toh bhi nhi pata bata batao bolo boliye haanji ' +
    'ko ka ki ke se le de mein ').split(/\s+/).filter(Boolean),
);

/**
 * The language to answer what they just said in, decided here rather than left
 * to the model, which kept answering Hindi typed in English letters in English.
 *
 * `current` is the language the conversation is already in. Words that say
 * nothing about language - "ok", "hello", "yes" - keep it there, so one word
 * does not flip the whole call into English and back.
 *
 * The voice listens in Hindi, so a sentence written in another Indian script is
 * a mishearing - it once turned "haan, sir" into Telugu and the agent answered
 * in Telugu - unless that language is the employee's own.
 *
 * Fewer than three words never switch it. A murmur or a voice in the room comes
 * through as one or two words - "हम्म", "बहुत" - and in Devanagari, and answering
 * that in Hindi turned an English call into Hindi on a sound.
 */
export function spokenLanguage(said: string, preferred: VoiceLanguage, current: VoiceLanguage = preferred): VoiceLanguage {
  if (said.trim().split(/\s+/).filter(Boolean).length < 3) return current;
  for (const [script, language] of SCRIPTS) {
    if (!script.test(said)) continue;
    if (language === 'hi-IN') return preferred === 'mr-IN' ? 'mr-IN' : 'hi-IN';
    return language === preferred ? language : current;
  }
  const words = said.toLowerCase().match(/[a-z]+/g) ?? [];
  const hindi = words.filter((w) => HINGLISH.has(w)).length;
  if (hindi >= 2 || (hindi >= 1 && words.length <= 3)) return 'hi-IN';
  return words.length >= 3 ? 'en-IN' : current;
}

/** The language of the agent's last line, which is the language the conversation is in. */
function languageSoFar(history: HistoryLine[], preferred: VoiceLanguage): VoiceLanguage {
  const last = [...history].reverse().find((line) => line.role === 'agent');
  if (!last) return 'en-IN';
  for (const [script, language] of SCRIPTS) {
    if (script.test(last.text)) return language === 'hi-IN' && preferred === 'mr-IN' ? 'mr-IN' : language;
  }
  return 'en-IN';
}

/** A line of the conversation as the model reads it, saying when the employee did not hear all of it. */
function historyLine(line: HistoryLine): string {
  if (line.role === 'employee') return `Employee: ${line.text}`;
  if (line.heard === undefined) return `You: ${line.text}`;
  return line.heard.trim() ? `You (cut off): ${line.heard}` : `You (not heard): ${line.text}`;
}

/*
 * The rules a long conversation most often loses, said again beside what they
 * just said, where the model attends to them: in testing it still told an
 * employee who had just said "half day" that they were absent the whole day,
 * and asked "what happened that day?" twice running.
 */
function beforeYouAnswer(history: HistoryLine[]): string {
  const last = [...history].reverse().find((line) => line.role === 'agent');
  return (
    'BEFORE YOU ANSWER: build on what they just said and never contradict it ("half day" is not a full day). ' +
    (last ? `Your last reply was: "${last.text}" - do not say it or its question again. ` : '') +
    'Do not open by repeating back what they said - answer directly. ' +
    'Anything the POLICY EXTRACTS explain, answer. Only when they ask you to do something you cannot - give a number, ' +
    'call back, act for them in the H R M S - say you have understood and will raise a ticket for it; never that H R ' +
    'will contact or call them. ' +
    '"Haan" or "ji" alone does not answer an either-or question: then ask one yes-or-no question about one of the ' +
    'two. If a question was already asked above, ask something narrower, or say what you have understood and check ' +
    'it. One question, never a list of options. hi-IN is written in Devanagari.'
  );
}

const spokenFor = (row: { attDate: string; meaning: string }) =>
  spokenDate(row.attDate, halfOfDay(row.meaning as Meaning) as 'first' | 'second' | null);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function addDays(iso: string, days: number): string {
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
  /** Whether the agent can apply things itself, and the leave types it could apply. */
  applying?: { agent: boolean; leaveTypes: string[] };
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

  const preferred = voiceLanguage(s.employee.language ?? ctx.settings.defaultLanguage);
  lines.push(`TODAY: ${spokenDate(now)}, ${WEEKDAYS[new Date(`${now}T00:00:00Z`).getUTCDay()]}`);
  lines.push(`EMPLOYEE: ${s.employee.fullName} (call them ${s.employee.fullName.split(/\s+/)[0]}), works at ${ctx.companyName}`);
  lines.push(`PREFERRED LANGUAGE: ${preferred}`);
  lines.push(
    agentGender(ctx.settings.agentVoice) === 'male'
      ? 'YOU: a man. In Hindi, speak of yourself as a man: "मैं समझ गया", "मैं देखता हूँ", "मैं बताता हूँ".'
      : 'YOU: a woman. In Hindi, speak of yourself as a woman: "मैं समझ गई", "मैं देखती हूँ", "मैं बताती हूँ".',
  );
  lines.push(
    chat
      ? 'THIS CONVERSATION: a WhatsApp chat about attendance. They may tap menu options or type.'
      : s.mode === 'inbound'
      ? 'THIS CALL: they rang us. Help with whatever they ask; there are no dates to go through, so outcome is always ' +
        '"none". Keep the call going (action "continue") until they say goodbye or that is all - never hand it over or ' +
        'end it because of what they are asking about.'
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
    lines.push(
      chat
        ? 'APPLY QUESTION: never ask it in a chat - it is asked with buttons once the outcome is set. Set application only if they have already said where it stands.'
        : s.applying?.agent
        ? `APPLY QUESTION: whether you should apply it for them in the H R M S ("apply_for_me"), or they will do it themselves ("not_applied"), or it is already applied ("applied").` +
            (s.applying.leaveTypes.length ? ` Leave types they can choose: ${s.applying.leaveTypes.join(', ')}.` : '')
        : 'APPLY QUESTION: whether they have already applied it and it is waiting for approval ("applied"), or not yet ("not_applied").',
    );
  }

  lines.push('', 'CONVERSATION SO FAR');
  lines.push(...(s.history.length ? s.history.slice(-14).map(historyLine) : ['(nothing yet)']));

  // What was looked up for this turn comes after the conversation, not before
  // it: it changes every turn, and everything above it is then the same as the
  // last turn's prompt, which Azure reuses from its cache at a quarter of the price.
  if (s.grounding?.passages.length) {
    lines.push('', `POLICY EXTRACTS\n${s.grounding.passages.map((p) => `[${p.title}] ${p.text}`).join('\n\n')}`);
  }
  if (s.grounding?.attendance) lines.push('', `ATTENDANCE\n${s.grounding.attendance}`);
  const reply = spokenLanguage(s.said ?? '', preferred, languageSoFar(s.history, preferred));
  if (chat) {
    lines.push('', `THEY JUST WROTE: "${s.said ?? ''}"\nREPLY IN: ${reply} (the language of what they just wrote)`, beforeYouAnswer(s.history));
    return lines.join('\n');
  }
  // Every call opens in English; from then on it follows the employee.
  lines.push(
    '',
    s.said === null
      ? 'The call has just been answered and they have greeted you. Open the call: say who you are and why you are calling, then ask your first question. REPLY IN: en-IN'
      : `THEY JUST SAID: "${s.said}"\nREPLY IN: ${reply} (the language of what they just said)\n${beforeYouAnswer(s.history)}`,
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
  /**
   * On a call we placed: when the employee cut the agent's last line off, the
   * part of it they heard - empty if they heard none of it.
   */
  heard?: string | null;
  /** Where a grounding started ahead of this turn would be. */
  preparedKey?: string;
  /** Tests stand in for the model. */
  model?: (request: { model: string; [key: string]: unknown }, onDelta: (delta: string) => void) => ReturnType<typeof streamChat>;
};

/** Said when the call cannot go on, in the language it was going on in. */
const HANDOVER_LINES: Partial<Record<VoiceLanguage, string>> = {
  'en-IN': 'Sorry, I am not able to continue this call right now. Someone from H R will contact you. Goodbye.',
  'hi-IN': 'माफ़ कीजिए, अभी यह call आगे नहीं हो पाएगी। H R से कोई आपसे contact करेगा। धन्यवाद।',
};
const LANGUAGE_FIELD = /"reply_language"\s*:\s*"([a-z]{2}-[A-Z]{2})"/;

export async function talkTurn(ctx: TalkContext, args: TalkArgs, onEvent: (event: TalkEvent) => void): Promise<TalkResult> {
  const { employee, call, mode } = args;
  const caseRow = args.caseRow;

  // A call about a manager's approval asks one fixed question - see approval-calls.ts.
  if (call && APPROVAL_CALL_PURPOSES.includes(call.purpose as ApprovalCallPurpose)) {
    const voice = ctx as unknown as VoiceContext;
    const turn = args.said === null ? await approvalOpening(voice, call) : await approvalTurn(voice, call, { speech: args.said });
    onEvent({ type: 'lang', language: 'en-IN' });
    onEvent({ type: 'text', text: [turn.intro, turn.speak].filter(Boolean).join(' ') });
    return { done: turn.done, nextCaseId: turn.nextCaseId, language: 'en-IN' };
  }

  // What the employee missed is written down before what they said in reply,
  // so the model knows not to treat an unheard question as asked.
  const transcript = call && args.heard != null ? await markHeard(ctx.tx, call, args.heard) : (call?.transcript ?? []);
  if (call && args.said !== null) await appendLine(ctx.tx, call.id, 'employee', args.said || '(silence)');

  const history: HistoryLine[] = call
    ? transcript.map((t) => ({ role: t.role, text: t.text, ...(t.heard !== undefined ? { heard: t.heard } : {}) }))
    : (args.history ?? []);
  const fallbackLanguage = languageSoFar(history, voiceLanguage(employee.language ?? ctx.settings.defaultLanguage));

  const giveUp = async (reason: string): Promise<TalkResult> => {
    const language = HANDOVER_LINES[fallbackLanguage] ? fallbackLanguage : 'en-IN';
    onEvent({ type: 'lang', language });
    onEvent({ type: 'text', text: HANDOVER_LINES[language]! });
    await handOver(ctx, args, reason);
    return { done: true, nextCaseId: null, language };
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
  // What the agent may offer at the apply step: to apply it itself, with an HRMS - and which leave.
  const agent = mode === 'first_contact' && agentCanApply(ctx as ApplyContext);
  const applying = {
    agent,
    leaveTypes: agent ? (await leaveTypesFor(ctx as ApplyContext, employee)).map((t) => `${t.type} (${t.days} days left)`) : [],
  };

  const request = {
    model: env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: describe(ctx, { mode, employee, caseRow, upcoming, manager, history, said: args.said, grounding, applying }),
      },
    ],
    temperature: 0.3,
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
    noteModelCost('openai', request.model, fromOpenAIUsage(result.usage), 'Conversation reply');
    void chargeBudget(budgetOf(mode), request.model, fromOpenAIUsage(result.usage)).catch((error) => console.error('[budget] could not record the cost:', (error as Error).message));
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
  /** Where an application stands, when they said it unasked ("I've already applied it"). */
  application: ApplicationStage | null;
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
    noteModelCost('openai', request.model, fromOpenAIUsage(result.usage), 'Chat reply');
    void chargeBudget('whatsapp', request.model, fromOpenAIUsage(result.usage)).catch((error) => console.error('[budget] could not record the cost:', (error as Error).message));
    const verdict = JSON.parse(result.raw) as Verdict;
    if (!verdict.reply?.trim()) return null;
    const outcome = verdict.outcome !== 'none' && OUTCOMES[verdict.outcome] ? verdict.outcome : null;
    return {
      reply: verdict.reply.trim(),
      outcome,
      leaveChoice: verdict.leave_choice === 'not_said' ? null : verdict.leave_choice,
      application: verdict.application === 'not_said' ? null : verdict.application,
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
    const code = verdict.outcome;
    const outcome = OUTCOMES[code];
    const choice = verdict.leave_choice === 'not_said' ? null : verdict.leave_choice;
    const stage = verdict.application === 'not_said' ? outcome?.application?.preset ?? null : verdict.application;
    // An absence is not settled until they have said leave or Loss of Pay, nor
    // anything applied for until they have said where it stands.
    const waiting = (outcome?.asksLeaveOrLossOfPay && !choice) || (needsApplication(code, choice) && !stage);
    if (outcome && !waiting) {
      await recordOutcome(ctx, caseRow, args.employee, code, choice, verdict.note, manager);
      if (needsApplication(code, choice) && stage) {
        const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) })) ?? caseRow;
        const facts = { date: spokenFor(caseRow), deadline: spokenDate(addDays(today(ctx.settings.timezone), ctx.settings.followUpAfterDays)), manager };
        await submitApplication(ctx as ApplyContext, fresh, args.employee, {
          code,
          choice,
          stage,
          leaveType: verdict.leave_type,
          note: verdict.note,
          via: 'call',
          facts,
        });
      }
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

/** The manager's first name: from their mobile in the file, else their code - see `approvals.ts`. */
async function managerName(tx: Db, employee: EmployeeRow): Promise<string | null> {
  return managerFirstName(tx, employee.tenantId, employee);
}

async function appendLine(tx: Db, callId: string, role: 'agent' | 'employee', text: string) {
  await tx
    .update(calls)
    .set({
      transcript: sql`coalesce(${calls.transcript}, '[]'::jsonb) || ${JSON.stringify([{ role, text, at: new Date().toISOString() }])}::jsonb`,
    })
    .where(eq(calls.id, callId));
}

/** Notes how much of the agent's last line the employee heard before cutting it off. */
async function markHeard(tx: Db, call: typeof calls.$inferSelect, heard: string) {
  const lines = [...(call.transcript ?? [])];
  const last = lines.map((line) => line.role).lastIndexOf('agent');
  if (last < 0 || lines[last]!.text.trim() === heard.trim()) return lines;
  lines[last] = { ...lines[last]!, heard };
  await tx.update(calls).set({ transcript: lines }).where(eq(calls.id, call.id));
  return lines;
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
