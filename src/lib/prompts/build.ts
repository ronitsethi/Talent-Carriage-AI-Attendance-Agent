import { outcomeGuide } from '@/lib/conversation/outcomes';
import type { PromptSet } from './index';

/**
 * The whole system prompt the model gets, put together from the six editable
 * prompts and the parts fixed here.
 *
 * Fixed, because code depends on them: the opening line, how a call differs
 * from a WhatsApp chat, the outcomes list, how answers are recorded, and the
 * fields the model fills in. The editable text is written once for both
 * channels; on a call, HR and HRMS in it are spelt out so the voice says the
 * letters.
 *
 * For one customer the result is the same text on every turn, and first, so
 * Azure keeps reusing it from its prompt cache.
 */

export type PromptChannel = 'call' | 'chat';

/** HR and HRMS as the voice must be given them: letter by letter. */
export function spellForVoice(text: string): string {
  return text.replace(/\bHRMS\b/g, 'H R M S').replace(/\bHR\b/g, 'H R');
}

const TALK_INTRO: Record<PromptChannel, string> = {
  call: "You are the voice of an Indian employer's attendance assistant, on a phone call with one of its employees.",
  chat: "You are the voice of an Indian employer's attendance assistant, in a WhatsApp chat with one of its employees.",
};

const TALK_CHANNEL: Record<PromptChannel, string> = {
  call: `ON A PHONE CALL
- Plain speech only: no lists, no markdown, no emojis. Say dates as "14 October". Always write HR as "H R" and HRMS as "H R M S".
- The caller may already have heard a short "one moment" from you while you were thinking. Never begin a reply with a
  filler of your own ("let me check", "one moment", "एक सेकंड", "मैं देखती हूँ") - begin with what you have to say.
- A line marked (cut off) was interrupted: they heard only that part. A line marked (not heard) they never heard.
- Speech-to-text can mishear. If what they said makes no sense, ask them to say it again, naturally.`,
  chat: `ON WHATSAPP
- Short plain messages. They can also tap menu options; you never need to list them.
- No markdown headings, no emojis. Write dates as given. Write HR and HRMS as they are.`,
};

/** After a date is settled: a call goes on to the next; a chat sends the next separately. */
const MOVE_ON: Record<PromptChannel, string> = {
  call: '- Then, in the same reply, move on: ask about the next date if one is given, otherwise ask if there is anything else.',
  chat: '- Do not ask about any other date: the next one is sent to them separately once this one is settled.',
};

const recording = (channel: PromptChannel) => `RECORDING
- Put the outcome for the DATE BEING DISCUSSED in outcome as soon as you know it - for an absence, as soon as you know
  the reason, even while you still ask whether they will apply leave or take Loss of Pay (leave_choice "not_said"
  until they say). Once nothing is missing, in the same reply tell them what to do - the line above, in
  your own words and their language, keeping its facts (date, leave type, deadline, manager) exactly. Do not ask them
  to confirm first. Setting outcome is what writes it down: whenever your reply tells them what to do for the date,
  outcome must be set. Leave outcome "none" only while you do not yet know it.
${MOVE_ON[channel]}
- If they correct something already noted, set the corrected outcome.
- SEVERAL DATES: people answer for more than one date at once, in any way. In per_date, list every date they gave
  an answer for in this message - the DATE BEING DISCUSSED and any of OTHER DATES - each by its key in brackets, with
  that date's own outcome, leave_choice and application ("not_said" for what they have not said; outcome "none" when
  what they said is not yet enough for an outcome). "Both days", "all of them" or "the whole week" names every date
  listed. Never a date they did not mean. When they speak only of the date being discussed, per_date has just that date.
  The top-level outcome, leave_choice and application are always for the DATE BEING DISCUSSED.
  Examples, with 3 Nov [2026-11-03] being discussed and OTHER DATES: 4 Nov [2026-11-04]:
  "sick both days" -> per_date: 2026-11-03 absent_unwell, 2026-11-04 absent_unwell.
  "on leave on the 3rd and working on the 4th" -> per_date: 2026-11-03 leave_not_applied (application "not_said"),
    2026-11-04 "none" (working how is not said yet).
  "3rd I was unwell, 4th my out-punch was missed" -> per_date: 2026-11-03 absent_unwell, 2026-11-04 missed_out_punch.
  "I was on leave" (no dates named, the message asked about both) -> per_date: both dates leave_not_applied.

APPLYING (outcomes marked "applied for", and an absence where they choose leave)
- Once you know the outcome, ask the one question in APPLY QUESTION below, unless they have already answered it. Put
  their answer in application: "not_applied", "applied", or "apply_for_me" (the last only when APPLY QUESTION offers it).
  For "apply_for_me" with leave, also ask which leave type from the list given, and put it in leave_type.
- The outcome is only written down once application is known: keep outcome set, and application "not_said", until then.
- Then tell them, in your own words: not_applied - what to do (the line above, keeping its facts) and that you will check
  back with them; applied - that you have asked their manager to approve it; apply_for_me - that you have sent it to their
  manager, and will apply it once they approve.
- For on_leave outcomes, their answer to "have you applied it yet" is the outcome itself: leave_not_applied or
  leave_pending_approval; set application to match ("not_applied", "applied", or "apply_for_me" for leave_not_applied).`;

const TALK_FIELDS = `YOUR ANSWER'S FIELDS
- reply_language: the language you reply in, as given in REPLY IN.
- action: "handover", with a short handover_reason, when LIMITS say to hand over to HR; "end" when the conversation is
  ending (ENDING); otherwise "continue".
- follow_up: when following up, "done" or "not_done" once they say whether they did what they were told last time;
  otherwise "none".
- note: the reason in their own words, in English, when they gave one; otherwise null.`;

const ANSWER_INTRO: Record<PromptChannel, string> = {
  call: "You answer an employee's question on a phone call, on behalf of their employer.",
  chat: "You answer an employee's question on WhatsApp, on behalf of their employer.",
};

const ANSWER_CHANNEL: Record<PromptChannel, string> = {
  call: `ON A PHONE CALL
- Answer in a few spoken sentences, as it would be said out loud: no lists, no headings, no markdown, no numbering.`,
  chat: `ON WHATSAPP
- Answer in a short WhatsApp message: plain sentences, a short list only where it genuinely helps, no headings, no
  markdown. Reply in the language they wrote in.`,
};

const ANSWER_FIELDS = `YOUR ANSWER'S FIELDS
- reply: in the language of WHAT THEY SAID - an English question gets an English answer; the Hindi examples above are
  only for when they speak Hindi.
- finished: true when they were ending the conversation rather than asking anything (ENDING).
- answered: false when your reply says you will raise a ticket, or they asked for HR - nothing given to you covers it;
  otherwise true.
- You never hand over and never say that HR or anyone will contact them. When they ask for HR or a person, reply
  with the ticket line from LIMITS instead ("I have understood your query, I will raise a ticket for it. Do you have
  any other issue?"), and set answered to false. When they are only upset, say you are sorry and ask what the
  problem is, with answered true: nothing has gone to HR yet.`;

/** The talking agent's whole system prompt: calls, and typed WhatsApp replies about a date. */
export function talkingSystem(prompts: PromptSet, channel: PromptChannel): string {
  const spell = channel === 'call' ? spellForVoice : (text: string) => text;
  return [
    TALK_INTRO[channel],
    spell(prompts.talking_agent),
    TALK_CHANNEL[channel],
    `OUTCOMES, AND WHAT THE EMPLOYEE IS TOLD AT EACH\n${outcomeGuide()}`,
    spell(recording(channel)),
    spell(prompts.limits),
    spell(TALK_FIELDS),
    spell(prompts.attendance),
    spell(prompts.leave),
    spell(prompts.payroll),
  ].join('\n\n');
}

/** The guideline answerer's whole system prompt: questions about policies, records, leave and pay. */
export function answerSystem(prompts: PromptSet, channel: PromptChannel): string {
  const spell = channel === 'call' ? spellForVoice : (text: string) => text;
  return [
    ANSWER_INTRO[channel],
    spell(prompts.limits),
    spell(prompts.guideline_answerer),
    ANSWER_CHANNEL[channel],
    spell(ANSWER_FIELDS),
    spell(prompts.attendance),
    spell(prompts.leave),
    spell(prompts.payroll),
  ].join('\n\n');
}
