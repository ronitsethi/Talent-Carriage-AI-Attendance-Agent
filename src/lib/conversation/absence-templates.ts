/**
 * The WhatsApp templates for asking about absences once per person: the first
 * message naming every unanswered date, the reminder when it is ignored, the
 * last warning before it goes to the manager, and the manager's own message.
 *
 * Meta approves each body word for word, so the app and
 * `scripts/create-ticket-templates.ts` both take them from here.
 */

/** The first question about every unanswered date at once. {{1}} first name, {{2}} the dates. */
export const ABSENT_GROUP_TEMPLATE = 'attendance_absent_v3';
export const ABSENT_GROUP_TEMPLATE_BODY =
  'Hi {{1}}, our attendance record shows you are marked absent on {{2}}. Please choose the reason below; it will be taken for every date listed. ' +
  'If different dates had different reasons, just type them here.';

/** The same question again, when it has gone unanswered. {{1}} first name, {{2}} the dates. */
export const ABSENT_REMINDER_TEMPLATE = 'attendance_absent_reminder';
export const ABSENT_REMINDER_TEMPLATE_BODY =
  'Hi {{1}}, this is to remind you that you are marked absent on {{2}}, and we have not heard from you yet. Please choose the reason below; ' +
  'it will be taken for every date listed. If different dates had different reasons, just type them here.';

/** The last word to the employee before the manager is told. {{1}} first name, {{2}} the dates, {{3}} who it goes to. */
export const ABSENT_ESCALATED_TEMPLATE = 'attendance_absent_escalated';
export const ABSENT_ESCALATED_TEMPLATE_BODY =
  'Hi {{1}}, we have not heard from you about your absence on {{2}}, despite our messages and calls. ' +
  'This has now been passed to {{3}}. Please speak to them about it.';

/** To the manager, about a team member who never answered. {{1}} who, {{2}} the dates. */
export const MANAGER_NO_RESPONSE_TEMPLATE = 'manager_no_response';
export const MANAGER_NO_RESPONSE_TEMPLATE_BODY =
  'Hello, this is the attendance assistant about your team member {{1}}. They are marked absent on {{2}} and have not replied to our messages ' +
  'and calls. Please speak to them, or tap Mark as Loss of Pay to close these dates as absent without pay. We will let them know.';

/** The manager's two buttons, as they read on the message. */
export const MANAGER_NO_RESPONSE_BUTTONS = { speak: "I'll speak to them", lossOfPay: 'Mark as Loss of Pay' } as const;

/** A reminder after the first, firmer. {{1}} first name, {{2}} the dates. */
export const ABSENT_REMINDER_FIRM_TEMPLATE = 'attendance_absent_reminder_firm';
export const ABSENT_REMINDER_FIRM_TEMPLATE_BODY =
  'Hi {{1}}, we are still waiting to hear from you about your absence on {{2}}. Please reply today by choosing the reason below; ' +
  'it will be taken for every date listed. If different dates had different reasons, just type them here.';

/** A date's last reminder, saying what happens next. {{1}} first name, {{2}} all the dates, {{3}} the dates at their last reminder, {{4}} who they go to. */
export const ABSENT_LAST_WARNING_TEMPLATE = 'attendance_absent_last_warning';
export const ABSENT_LAST_WARNING_TEMPLATE_BODY =
  'Hi {{1}}, this is the last reminder about your absence on {{2}}. If we do not hear from you, {{3}} will then go to {{4}}. ' +
  'Please choose the reason below; it will be taken for every date listed. If different dates had different reasons, just type them here.';
