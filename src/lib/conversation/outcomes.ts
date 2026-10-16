import type { OptionNumber } from './flow';

/**
 * Where a conversation about one absent date can end up.
 *
 * This is the customer's flow sheet ("Reminder Reply"), turned from a menu into
 * a list of destinations. On a talking call the agent may reach one by any
 * route - "bike kharab ho gayi, 11 baje pahuncha" lands on `came_late` without
 * anybody choosing "I was working" first - but it can only ever land on one of
 * these, and what the employee is told to do there is written here, not by the
 * model.
 *
 * Each outcome still maps to one of the four first-step options, because the
 * day-2 reminder, the WhatsApp chain and the portal all speak in those.
 */

export type OutcomeCode =
  | 'absent_unwell'
  | 'absent_family_emergency'
  | 'absent_personal_work'
  | 'absent_other'
  | 'resigned'
  | 'came_late'
  | 'left_early'
  | 'late_and_early'
  | 'missed_in_punch'
  | 'missed_out_punch'
  | 'missed_both_punches'
  | 'on_duty_client_visit'
  | 'on_duty_field_work'
  | 'on_duty_official_travel'
  | 'on_duty_training'
  | 'regularisation_already_sent'
  | 'leave_not_applied'
  | 'leave_pending_approval'
  | 'weekly_off'
  | 'comp_off';

/** What the employee wants done about a day they did not work. */
export type LeaveChoice = 'leave' | 'loss_of_pay';

type Facts = { date: string; deadline: string; manager: string | null };

export type Outcome = {
  /** How HR reads it in the portal. */
  label: string;
  /** The branch of the sheet, for the model to find its way around. */
  group: 'I did not come' | 'I was working' | 'I was on leave' | 'Weekly off / comp off';
  option: OptionNumber;
  /** They did not work, so they choose: apply leave, or take it as Loss of Pay. */
  asksLeaveOrLossOfPay?: boolean;
  /** Nothing for the employee to do; a person at HR takes it from here. */
  handover?: string;
  /** What they are told to do, from the sheet. */
  instruction: (facts: Facts) => string;
};

const applyLeave = ({ date, deadline }: Facts) => `Please apply leave for ${date} in the HRMS by ${deadline}.`;

export const OUTCOMES: Record<OutcomeCode, Outcome> = {
  absent_unwell: {
    label: 'Absent - unwell',
    group: 'I did not come',
    option: 1,
    asksLeaveOrLossOfPay: true,
    instruction: ({ date, deadline }) =>
      `Please apply Sick Leave, or any leave you have available, for ${date} in the HRMS by ${deadline}.`,
  },
  absent_family_emergency: {
    label: 'Absent - family emergency',
    group: 'I did not come',
    option: 1,
    asksLeaveOrLossOfPay: true,
    instruction: applyLeave,
  },
  absent_personal_work: {
    label: 'Absent - personal work',
    group: 'I did not come',
    option: 1,
    asksLeaveOrLossOfPay: true,
    instruction: applyLeave,
  },
  absent_other: {
    label: 'Absent - other reason',
    group: 'I did not come',
    option: 1,
    asksLeaveOrLossOfPay: true,
    instruction: applyLeave,
  },
  resigned: {
    label: 'Says they have resigned or joined another company',
    group: 'I did not come',
    option: 1,
    handover: 'Says they have resigned or joined another company',
    instruction: () => 'Okay, we will inform the HR Manager about this.',
  },
  came_late: {
    label: 'Came late',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please raise a late-coming regularisation for ${date} in the HRMS.`,
  },
  left_early: {
    label: 'Left early',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please raise an early-going regularisation for ${date} in the HRMS.`,
  },
  late_and_early: {
    label: 'Came late and left early',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please raise a regularisation for late coming and early going on ${date} in the HRMS.`,
  },
  missed_in_punch: {
    label: 'Worked in office - missed in-punch',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) =>
      `Please raise a regularisation for your missed in-punch on ${date} in the HRMS, with your actual in-time.`,
  },
  missed_out_punch: {
    label: 'Worked in office - missed out-punch',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) =>
      `Please raise a regularisation for your missed out-punch on ${date} in the HRMS, with your actual out-time.`,
  },
  missed_both_punches: {
    label: 'Worked in office - missed both punches',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) =>
      `Please raise a regularisation for both punches on ${date} in the HRMS, with your actual in and out times.`,
  },
  on_duty_client_visit: {
    label: 'Worked outside - client visit',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please apply On-Duty, client visit, for ${date} in the HRMS.`,
  },
  on_duty_field_work: {
    label: 'Worked outside - field work',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please apply On-Duty, field work, for ${date} in the HRMS.`,
  },
  on_duty_official_travel: {
    label: 'Worked outside - official travel',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please apply On-Duty, official travel, for ${date} in the HRMS.`,
  },
  on_duty_training: {
    label: 'Worked outside - company training',
    group: 'I was working',
    option: 2,
    instruction: ({ date }) => `Please apply On-Duty, training, for ${date} in the HRMS.`,
  },
  // Not in the sheet, but employees say it, and telling them to raise a
  // regularisation they have already raised would be wrong.
  regularisation_already_sent: {
    label: 'Already sent a regularisation request',
    group: 'I was working',
    option: 4,
    instruction: ({ date, manager }) =>
      `Okay. Please ask ${manager ?? 'your manager'} to approve your regularisation for ${date}.`,
  },
  leave_not_applied: {
    label: 'On leave - not applied yet',
    group: 'I was on leave',
    option: 1,
    instruction: applyLeave,
  },
  // The sheet has us telling the manager; until there is a message to the
  // manager for this, the employee is asked to, as the flow does today.
  leave_pending_approval: {
    label: 'On leave - applied, waiting for approval',
    group: 'I was on leave',
    option: 3,
    instruction: ({ date, manager }) => `Okay. Please ask ${manager ?? 'your manager'} to approve your leave for ${date}.`,
  },
  weekly_off: {
    label: 'Says it was their weekly off',
    group: 'Weekly off / comp off',
    option: 2,
    handover: 'Says it was their weekly off - weekly off change request',
    instruction: () => 'Okay, a weekly off change request will be raised to HR.',
  },
  comp_off: {
    label: 'Comp off',
    group: 'Weekly off / comp off',
    option: 1,
    instruction: ({ date }) => `Please apply comp-off for ${date} in the HRMS.`,
  },
};

export const OUTCOME_CODES = Object.keys(OUTCOMES) as OutcomeCode[];

export const LOSS_OF_PAY = ({ date }: Facts) => `Noted. ${date} will be treated as Loss of Pay as per policy.`;

/** What the employee is told for this outcome. */
export function instructionFor(code: OutcomeCode, choice: LeaveChoice | null, facts: Facts): string {
  if (OUTCOMES[code].asksLeaveOrLossOfPay && choice === 'loss_of_pay') return LOSS_OF_PAY(facts);
  return OUTCOMES[code].instruction(facts);
}

/** The sheet, written out for the model: each outcome, its branch, and what is said there. */
export function outcomeGuide(): string {
  const facts = { date: '{date}', deadline: '{deadline}', manager: '{manager}' };
  const groups = new Map<string, string[]>();
  for (const code of OUTCOME_CODES) {
    const o = OUTCOMES[code];
    const lines = groups.get(o.group) ?? [];
    const then = o.asksLeaveOrLossOfPay
      ? `ask whether they will apply leave or take Loss of Pay. Leave: "${o.instruction(facts)}" Loss of Pay: "${LOSS_OF_PAY(facts)}"`
      : `"${o.instruction(facts)}"`;
    lines.push(`- ${code} (${o.label}): ${then}`);
    groups.set(o.group, lines);
  }
  return [...groups].map(([group, lines]) => `${group}\n${lines.join('\n')}`).join('\n\n');
}
