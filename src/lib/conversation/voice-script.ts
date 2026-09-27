import { OPTIONS, OPTION_NUMBERS, firstName, systemReply, type OptionNumber } from './flow';

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

export function spokenClosing(cleared: number, remaining: number): string {
  if (remaining > 0) {
    return `Thank you. ${remaining} ${remaining === 1 ? 'day is' : 'days are'} still pending, and we will call you again. Goodbye.`;
  }
  if (cleared > 1) return `Thank you. All ${cleared} days are now confirmed. Goodbye.`;
  return `Thank you. Goodbye.`;
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
