import type { Meaning } from '@/lib/mapping/meanings';
import type { ListRow, OutboundList, OutboundTemplate } from '@/lib/channels/types';

/**
 * Everything an employee or manager ever hears, in one place.
 *
 * The first message of a date must be a Meta-approved template, so the text here
 * mirrors the approved wording for the transcript and the portal preview. Every
 * later message in the same conversation is generated here and sent as-is.
 */

export const OPTIONS = {
  1: {
    intent: 'was_absent' as const,
    label: 'Yes, I was absent',
    /** Template quick-reply titles may run to 25 characters. */
    templateButton: 'Yes, I was absent',
    /** In-conversation list rows may run to 24. */
    listTitle: 'Yes, I was absent',
    listDescription: 'I was not at work that day',
    action: 'Apply leave or unpaid leave',
  },
  2: {
    intent: 'was_working' as const,
    label: 'No, I was working',
    templateButton: 'No, I was working',
    listTitle: 'No, I was working',
    listDescription: 'My attendance was not recorded',
    action: 'Apply regularisation',
  },
  3: {
    intent: 'leave_already_applied' as const,
    label: 'I have already applied leave',
    templateButton: 'Already applied leave',
    listTitle: 'Already applied leave',
    listDescription: 'Waiting for my manager to approve',
    action: 'Manager to approve leave',
  },
  4: {
    intent: 'regularisation_already_sent' as const,
    label: 'I have already sent regularisation request',
    templateButton: 'Sent regularisation',
    listTitle: 'Sent regularisation',
    listDescription: 'Waiting for my manager to approve',
    action: 'Manager to approve regularisation',
  },
} as const;

export type OptionNumber = 1 | 2 | 3 | 4;
export const OPTION_NUMBERS: OptionNumber[] = [1, 2, 3, 4];

export const INTENT_TO_OPTION: Record<string, OptionNumber> = {
  was_absent: 1,
  was_working: 2,
  leave_already_applied: 3,
  regularisation_already_sent: 4,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS[(m ?? 1) - 1]}-${y}`;
}

/** "18-Aug-2026", or "18-Aug-2026 (second half)" when only half the day is missing. */
export function dateLabel(isoDate: string, meaning: Meaning): string {
  const base = formatDate(isoDate);
  switch (meaning) {
    case 'absent_first_half':
      return `${base} (first half)`;
    case 'absent_second_half':
      return `${base} (second half)`;
    case 'absent_half_unspecified':
      return `${base} (half day)`;
    case 'missed_punch':
      return `${base} (missed punch)`;
    default:
      return base;
  }
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/** Mirrors the approved template: two variables, four quick-reply buttons. */
export function firstStepBody(name: string, label: string): string {
  return `Hi ${name}, our attendance record shows you are marked absent on ${label}. Please confirm the reason by choosing one option below.`;
}

/** Full text including the options, for the transcript and the HR preview. */
export function firstStepPreview(name: string, label: string): string {
  const options = OPTION_NUMBERS.map((n) => `${n}. ${OPTIONS[n].label}`).join('\n');
  return `${firstStepBody(name, label)}\n\n${options}`;
}

export function systemReply(option: OptionNumber, label: string): string {
  switch (option) {
    case 1:
      return 'Please apply leave if leave balance is available. If leave balance is not available, please follow the HR process for unpaid leave/regularization and get it approved by your manager.';
    case 2:
      return `Please apply attendance regularization for ${label} and get it approved by your manager.`;
    case 3:
      return `Please ask your manager to approve your leave for ${label}.`;
    case 4:
      return `Please ask your manager to approve your regularization request for ${label}.`;
  }
}

export function clarifyMessage(label: string): string {
  return `Sorry, I could not understand that. About ${label}, please choose one of the options below.`;
}

/**
 * Sent after a date is answered, when other dates are still waiting.
 *
 * Unanswered dates are never chased on their own, so this summary is the only
 * nudge an employee gets for the rest of the backlog — and it only appears
 * because they engaged.
 */
export function backlogSummary(remaining: number, dateLabels: string[]): string {
  const dayWord = remaining === 1 ? 'day' : 'days';
  const shown = dateLabels.slice(0, 5).join(', ');
  const andMore = dateLabels.length > 5 ? `, and ${dateLabels.length - 5} more` : '';
  return `Thank you. ${remaining} ${dayWord} of pending attendance ${remaining === 1 ? 'is' : 'are'} still to be confirmed: ${shown}${andMore}.`;
}

/** The next date's question, asked inside the conversation rather than as a template. */
export function nextDateQuestion(name: string, label: string, remaining: number): string {
  const counter = remaining > 1 ? ` (1 of ${remaining})` : '';
  return `${name}, about ${label}${counter} — please confirm the reason by choosing one option below.`;
}

export function allClearedMessage(count: number): string {
  return count === 1
    ? 'That was your last pending attendance date. Thank you.'
    : `All ${count} pending attendance dates are now confirmed. Thank you.`;
}

/** The list rows for the four options, tagged with the case they belong to. */
export function optionRows(caseId: string): ListRow[] {
  return OPTION_NUMBERS.map((n) => ({
    id: selectionId(caseId, n),
    title: OPTIONS[n].listTitle,
    description: OPTIONS[n].listDescription,
  }));
}

export function selectionId(caseId: string, option: OptionNumber): string {
  return `case:${caseId}:${option}`;
}

/** Reads a button or list payload back into the case and option it names. */
export function parseSelectionId(value: string | undefined | null): { caseId: string; option: OptionNumber } | null {
  const match = /^case:([0-9a-f-]{36}):([1-4])$/i.exec(value ?? '');
  if (!match) return null;
  return { caseId: match[1]!, option: Number(match[2]) as OptionNumber };
}

/** Day-2 follow-up wording, which depends on what the employee originally said. */
export function followUpMessage(option: OptionNumber, label: string): { body: string; buttons: string[] } {
  switch (option) {
    case 1:
      return {
        body: `Reminder: have you completed the leave/unpaid leave process for ${label} and got it approved by your manager?`,
        buttons: ['Done', 'Not done', 'Need help'],
      };
    case 2:
      return {
        body: `Reminder: have you submitted regularization for ${label} and got it approved by your manager?`,
        buttons: ['Done', 'Not done', 'Need help'],
      };
    case 3:
      return {
        body: `Reminder: has your manager approved your leave for ${label}?`,
        buttons: ['Approved', 'Not approved', 'Need help'],
      };
    case 4:
      return {
        body: `Reminder: has your manager approved your regularization request for ${label}?`,
        buttons: ['Approved', 'Not approved', 'Need help'],
      };
  }
}

export function callOpening(name: string, label: string, company: string): string {
  return `Hello ${name}, this is an automated HR assistant from ${company}. Your attendance action for ${label} is still pending. Have you completed the leave or regularization process?`;
}

export function callKeypadFallback(): string {
  return 'Press 1 if it is completed, 2 if it is not, or 3 to be contacted by HR.';
}

/** Messages to the manager, used once actions are enabled. */
export const managerMessages = {
  approvalRequest(employeeName: string, actionLabel: string, label: string, reason?: string) {
    const because = reason ? ` Reason: ${reason}.` : '';
    return `${employeeName} has requested ${actionLabel} for ${label}.${because}`;
  },
  nudge(employeeName: string, actionLabel: string, label: string) {
    return `Reminder: ${employeeName}'s ${actionLabel} for ${label} is waiting for your approval.`;
  },
  digest(count: number) {
    return `${count} attendance ${count === 1 ? 'item' : 'items'} ${count === 1 ? 'is' : 'are'} pending with you. Reply to see them one by one.`;
  },
};

/** Sent when an employee asks to stop; opt-out is permanent and must be honoured. */
export const optOutConfirmation =
  'Understood - you will not receive further automated attendance messages. Your HR team has been informed.';

export const handedToHrMessage =
  'I have passed this to your HR team, and someone will follow up with you directly.';

/** Builds the template send for the first step of a date. */
export function buildFirstStepTemplate(args: {
  to: string;
  templateName: string;
  language: string;
  employeeName: string;
  label: string;
  caseId: string;
  buttonCount: number;
}): OutboundTemplate {
  const name = firstName(args.employeeName);
  return {
    kind: 'template',
    to: args.to,
    templateName: args.templateName,
    language: args.language,
    variables: [name, args.label],
    buttonPayloads: OPTION_NUMBERS.slice(0, args.buttonCount).map((n) => selectionId(args.caseId, n)),
    preview: firstStepPreview(name, args.label),
  };
}

/** Builds the in-conversation version of the same question, as a list. */
export function buildOptionList(args: {
  to: string;
  employeeName: string;
  label: string;
  caseId: string;
  remaining: number;
  body?: string;
}): OutboundList {
  return {
    kind: 'list',
    to: args.to,
    body: args.body ?? nextDateQuestion(firstName(args.employeeName), args.label, args.remaining),
    buttonLabel: 'Choose a reason',
    rows: optionRows(args.caseId),
    footer: 'Reply with 1, 2, 3 or 4 if you prefer',
  };
}

/* ------------------------------------------------------------------ *
 * Actions: offering to do the work, and asking the manager
 * ------------------------------------------------------------------ */

export type OfferChoice = 'accept' | 'self' | 'other_type';

export function offerSelectionId(caseId: string, choice: OfferChoice): string {
  return `offer:${caseId}:${choice}`;
}

export function parseOfferSelectionId(value: string | undefined | null): { caseId: string; choice: OfferChoice } | null {
  const match = /^offer:([0-9a-f-]{36}):(accept|self|other_type)$/i.exec(value ?? '');
  if (!match) return null;
  return { caseId: match[1]!, choice: match[2] as OfferChoice };
}

export function leaveTypeSelectionId(caseId: string, leaveType: string): string {
  return `ltype:${caseId}:${leaveType}`;
}

export function parseLeaveTypeSelectionId(value: string | undefined | null): { caseId: string; leaveType: string } | null {
  const match = /^ltype:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,20})$/i.exec(value ?? '');
  if (!match) return null;
  return { caseId: match[1]!, leaveType: match[2]! };
}

export type ApprovalChoice = 'approve' | 'reject' | 'details';

export function approvalSelectionId(approvalId: string, choice: ApprovalChoice): string {
  return `appr:${approvalId}:${choice}`;
}

export function parseApprovalSelectionId(
  value: string | undefined | null,
): { approvalId: string; choice: ApprovalChoice } | null {
  const match = /^appr:([0-9a-f-]{36}):(approve|reject|details)$/i.exec(value ?? '');
  if (!match) return null;
  return { approvalId: match[1]!, choice: match[2] as ApprovalChoice };
}

/** What the agent offers to do, in the employee's own terms. */
export const actionLabels = {
  apply_leave: 'leave',
  apply_regularisation: 'attendance regularisation',
  apply_unpaid_leave: 'unpaid leave',
} as const;

export function offerLeaveMessage(label: string, leaveType: string, balanceDays: number): string {
  return `You have ${balanceDays} day(s) of ${leaveType} available. Shall I apply ${leaveType} for ${label} and send it to your manager for approval?`;
}

export function offerRegularisationMessage(label: string): string {
  return `Shall I apply attendance regularisation for ${label} and send it to your manager for approval?`;
}

export function offerDeclinedMessage(): string {
  return 'No problem - please apply it yourself in the HRMS and ask your manager to approve it.';
}

export function actionSubmittedMessage(what: string, label: string, managerName: string | null): string {
  const who = managerName ? ` to ${managerName}` : ' to your manager';
  return `Done. Your ${what} for ${label} has been submitted and sent${who} for approval.`;
}

export function actionApprovedMessage(what: string, label: string, reference: string | null): string {
  const ref = reference ? ` Reference: ${reference}.` : '';
  return `Your ${what} for ${label} has been approved.${ref}`;
}

export function actionRejectedMessage(what: string, label: string, note?: string | null): string {
  const because = note ? ` Reason: ${note}.` : '';
  return `Your ${what} for ${label} was not approved.${because} Please speak to your manager or HR.`;
}

export function actionFailedMessage(what: string, label: string): string {
  return `I could not complete your ${what} for ${label} automatically. HR has been notified and will sort it out.`;
}

export function preCheckFailedMessage(reason: string): string {
  return `I could not do that for you: ${reason}. Please follow the HR process and ask your manager to approve it.`;
}

export function managerDecisionAck(decision: 'approved' | 'rejected', employeeName: string, label: string): string {
  return decision === 'approved'
    ? `Approved. ${employeeName}'s request for ${label} has been recorded.`
    : `Recorded as not approved. ${employeeName} has been informed.`;
}

/* ------------------------------------------------------------------ *
 * Day-2 follow-up, which applies only to dates the employee answered
 * ------------------------------------------------------------------ */

export type FollowUpChoice = 'done' | 'not_done' | 'help';

export function followUpSelectionId(caseId: string, choice: FollowUpChoice): string {
  return `fu:${caseId}:${choice}`;
}

export function parseFollowUpSelectionId(
  value: string | undefined | null,
): { caseId: string; choice: FollowUpChoice } | null {
  const match = /^fu:([0-9a-f-]{36}):(done|not_done|help)$/i.exec(value ?? '');
  if (!match) return null;
  return { caseId: match[1]!, choice: match[2] as FollowUpChoice };
}

export function followUpAcknowledgement(choice: FollowUpChoice, label: string): string {
  switch (choice) {
    case 'done':
      return `Thank you. I will confirm ${label} against the HRMS record and close it.`;
    case 'not_done':
      return `Thank you for telling me. Please complete it for ${label} as soon as you can - HR has been informed.`;
    case 'help':
      return 'I have asked HR to contact you and help with this.';
  }
}
