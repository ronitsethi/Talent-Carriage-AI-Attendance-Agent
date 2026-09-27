import {
  OPTIONS,
  OPTION_NUMBERS,
  firstName,
  systemReply,
  type FollowUpChoice,
  type OptionNumber,
} from './flow';

/**
 * The same flow as WhatsApp, said out loud.
 *
 * Spoken wording differs from written: no bullet lists, no "tap", numbers read
 * as words where it helps, and every prompt repeats what the keys mean because
 * the listener cannot scroll back.
 */

/** Dates are read as "twenty-one September", not "21-Sep-2026". */
export function spokenDate(isoDate: string, half?: 'first' | 'second' | null): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const [, month, day] = isoDate.split('-').map(Number);
  const base = `${day} ${months[(month ?? 1) - 1]}`;
  if (half === 'first') return `${base}, first half`;
  if (half === 'second') return `${base}, second half`;
  return base;
}

export function callGreeting(employeeName: string, company: string): string {
  return `Hello ${firstName(employeeName)}. This is the attendance assistant from ${company}.`;
}

/** Said once, at the start, when more than one date is outstanding. */
export function callBacklogOpening(pendingCount: number): string {
  if (pendingCount <= 1) return '';
  return `Our records show ${pendingCount} days of attendance still to be confirmed.`;
}

/** The four options, worded for the keypad. */
export function datePrompt(spoken: string): string {
  return [
    `About ${spoken}.`,
    `Press 1 if you were absent.`,
    `Press 2 if you were working.`,
    `Press 3 if you have already applied leave.`,
    `Press 4 if you have already sent a regularisation request.`,
    `You can also just say your answer.`,
  ].join(' ');
}

/**
 * The day-2 reminder, said out loud.
 *
 * It names what the employee was told to do last time, because on a call they
 * cannot scroll back to the earlier message. The keys mean something different
 * here from the first call, so the prompt spells them out again.
 */
export function followUpPrompt(option: OptionNumber, spoken: string): string {
  // The date is already named by the sentence before this one, so it is not
  // repeated here: hearing it twice in one breath sounds like a fault.
  const asked = {
    1: 'you told us you were absent, and we asked you to apply leave',
    2: 'you told us you were working, and we asked you to apply attendance regularisation',
    3: 'you told us you had already applied leave, and we asked your manager to approve it',
    4: 'you told us you had already sent a regularisation request, and we asked your manager to approve it',
  }[option];
  const done = option === 1 || option === 2 ? 'it is done' : 'it has been approved';
  const notDone = option === 1 || option === 2 ? 'it is not done yet' : 'it is not approved yet';

  return [
    `About ${spoken}. Last time, ${asked}.`,
    `Press 1 if ${done}.`,
    `Press 2 if ${notDone}.`,
    `Press 3 if you need help from H R.`,
    `You can also just say your answer.`,
  ].join(' ');
}

/** What the agent says once the employee has answered the reminder. */
export function spokenFollowUpAcknowledgement(choice: FollowUpChoice, spoken: string): string {
  switch (choice) {
    case 'done':
      return `Thank you. We will check ${spoken} against the H R record and close it.`;
    case 'not_done':
      return `Thank you for telling us. Please complete it for ${spoken} as soon as you can. H R has been informed.`;
    case 'help':
      return `No problem. We have asked H R to contact you and help with ${spoken}.`;
  }
}

/** Said before moving on to the next date whose action is still being chased. */
export function spokenFollowUpSummary(remaining: number): string {
  const days = remaining === 1 ? 'day' : 'days';
  return `There ${remaining === 1 ? 'is' : 'are'} ${remaining} more ${days} to check.`;
}

export function spokenFollowUpClosing(remaining: number): string {
  if (remaining > 0) return `We will check the rest with you another time. Goodbye.`;
  return `That is everything. Goodbye.`;
}

export function spokenFollowUpNotUnderstood(): string {
  return `Sorry, I did not catch that. Please press 1, 2 or 3.`;
}

/**
 * Reads a spoken answer to the reminder.
 *
 * The reminder is a yes/no question, which the reply classifier is not: that
 * one decides *why* somebody was absent. So plain rules answer it here, in
 * English and the Hinglish people actually say on the phone, and anything they
 * do not cover falls through to the classifier for the "I need help" case.
 */
export function followUpChoiceFromSpeech(speech: string): FollowUpChoice | null {
  const said = speech.toLowerCase().trim();
  if (!said) return null;

  if (/\b(help|hr|human|samajh nahi|baat kara)/.test(said)) return 'help';
  if (/\b(not yet|haven'?t|have not|didn'?t|did not|no|nope|nahi|nahin|pending|abhi nahi|baaki)/.test(said)) {
    return 'not_done';
  }
  if (/\b(done|yes|yeah|yep|approved|completed|applied|submitted|ho gaya|kar diya|ha+n)\b/.test(said)) {
    return 'done';
  }
  return null;
}

/** Keypad digit to a reminder answer, the mirror of `optionFromDigits`. */
export function followUpChoiceFromDigits(digits: string | undefined): FollowUpChoice | null {
  switch ((digits ?? '').trim()) {
    case '1':
      return 'done';
    case '2':
      return 'not_done';
    case '3':
      return 'help';
    default:
      return null;
  }
}

/** Shorter than the written guidance: a listener cannot re-read a long sentence. */
export function spokenGuidance(option: OptionNumber, spoken: string): string {
  switch (option) {
    case 1:
      return `Thank you. Please apply leave for ${spoken} if you have balance available. If not, please follow the unpaid leave or regularisation process and get it approved by your manager.`;
    case 2:
      return `Thank you. Please apply attendance regularisation for ${spoken} and get it approved by your manager.`;
    case 3:
      return `Thank you. Please ask your manager to approve your leave for ${spoken}.`;
    case 4:
      return `Thank you. Please ask your manager to approve your regularisation request for ${spoken}.`;
  }
}

/**
 * Said after a date is answered, before moving to the next one. It deliberately
 * does not name the next date: the prompt that follows says "About 21
 * September", and hearing the date twice is confusing out loud.
 */
export function spokenBacklogSummary(remaining: number): string {
  const days = remaining === 1 ? 'day' : 'days';
  return `You have ${remaining} more ${days} pending.`;
}

export function spokenNotUnderstood(): string {
  return `Sorry, I did not catch that. Please press 1, 2, 3 or 4.`;
}

/**
 * The last thing said on a call. It follows the guidance for the final date,
 * which already opens with "Thank you", so it does not thank them twice.
 */
export function spokenClosing(cleared: number, remaining: number): string {
  if (remaining > 0) {
    return `${remaining} ${remaining === 1 ? 'day is' : 'days are'} still pending, and we will call you again. Goodbye.`;
  }
  if (cleared > 1) return `All ${cleared} days are now confirmed. Goodbye.`;
  return `Goodbye.`;
}

export function spokenHandover(): string {
  return `I have passed this to your HR team, and someone will contact you directly. Goodbye.`;
}

/** Keypad digit to option, so a press and a spoken "two" mean the same thing. */
export function optionFromDigits(digits: string | undefined): OptionNumber | null {
  const match = /^[1-4]$/.exec((digits ?? '').trim());
  return match ? (Number(match[0]) as OptionNumber) : null;
}

/** The written guidance, kept for the case record and the portal transcript. */
export function writtenGuidance(option: OptionNumber, label: string): string {
  return systemReply(option, label);
}

export const SPOKEN_OPTIONS = OPTION_NUMBERS.map((n) => `${n}: ${OPTIONS[n].label}`).join(', ');
