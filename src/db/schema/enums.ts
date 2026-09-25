import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * The canonical attendance vocabulary. Every customer's own codes (A|A, Ab, 0.5,
 * PRESENT, CL, ...) are mapped onto exactly one of these, so the engine and the
 * reports never have to know a customer's dialect.
 */
export const attendanceMeaning = pgEnum('attendance_meaning', [
  'present',
  'absent_full',
  'absent_first_half',
  'absent_second_half',
  'absent_half_unspecified',
  'missed_punch',
  'short_hours',
  'late_in',
  'early_out',
  'leave_approved',
  'leave_pending',
  'leave_rejected',
  'leave_unpaid',
  'on_duty',
  'work_from_home',
  'travel',
  'training',
  'comp_off',
  'weekly_off',
  'holiday',
  'optional_holiday',
  'suspension',
  'long_leave',
  'not_employed',
  'unknown',
]);

/** Meanings that are a gap worth chasing, unless a tenant says otherwise. */
export const CHASED_BY_DEFAULT = [
  'absent_full',
  'absent_first_half',
  'absent_second_half',
  'absent_half_unspecified',
  'missed_punch',
] as const;

/** Meanings a tenant may opt into chasing. */
export const OPTIONALLY_CHASED = ['short_hours', 'late_in', 'early_out', 'leave_unpaid'] as const;

/** Meanings that must never produce a message, whatever the configuration says. */
export const NEVER_CHASED = [
  'weekly_off',
  'holiday',
  'optional_holiday',
  'not_employed',
  'suspension',
  'long_leave',
  'unknown',
] as const;

/** Meanings that explain a day, so an open case for it can be closed. */
export const EXPLAINS_ABSENCE = [
  'present',
  'leave_approved',
  'on_duty',
  'work_from_home',
  'travel',
  'training',
  'comp_off',
] as const;

export const userRole = pgEnum('user_role', [
  'platform_admin', // Talent Carriage staff, all tenants
  'hr_admin', // customer: configures rules, mappings, policy
  'hr_user', // customer: works the daily queue
  'manager', // customer: approves their team's requests
  'auditor', // customer: read-only
]);

export const tenantStatus = pgEnum('tenant_status', ['onboarding', 'active', 'suspended', 'offboarded']);

/**
 * A case is one employee and one dated gap.
 *
 * queued  -> detected but deliberately not asked yet (outstanding-question cap)
 * asked   -> first message sent; stays here indefinitely if the employee never
 *            answers. Unanswered dates are never reminded, by design.
 * answered -> the employee chose an option; guidance sent
 * awaiting_action / awaiting_approval -> an action is being carried out
 * resolved -> the day is explained and any action completed
 * needs_hr -> a human must look at it
 */
export const caseStatus = pgEnum('case_status', [
  'queued',
  'asked',
  'delivered',
  'read',
  'answered',
  'awaiting_action',
  'awaiting_approval',
  'resolved',
  'needs_hr',
  'failed',
  'cancelled',
]);

/** The four options from the flowchart, plus what the agent inferred from free text. */
export const replyIntent = pgEnum('reply_intent', [
  'was_absent', // 1
  'was_working', // 2
  'leave_already_applied', // 3
  'regularisation_already_sent', // 4
  'question', // asked something instead of answering
  'needs_help', // wants a human
  'other', // on-topic but none of the above
  'unclear', // could not be classified
]);

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);

export const messageKind = pgEnum('message_kind', [
  'template', // business-initiated, pre-approved wording
  'text', // free-form, inside the 24h window
  'interactive', // free-form with reply buttons
  'voice', // spoken turn on a call
  'note', // internal, never delivered
]);

export const messageStatus = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'received',
  'simulated',
]);

export const channel = pgEnum('channel', ['whatsapp', 'voice', 'sms', 'email', 'portal']);

export const actionType = pgEnum('action_type', [
  'apply_leave',
  'apply_regularisation',
  'apply_unpaid_leave',
  'approve_leave',
  'approve_regularisation',
  'cancel_request',
  'raise_hr_ticket',
  'nudge_manager',
  'close_case',
]);

export const actionStatus = pgEnum('action_status', [
  'draft',
  'pre_check_failed',
  'awaiting_approval',
  'approved',
  'rejected',
  'executing',
  'executed',
  'unconfirmed', // written, but the HRMS gave us nothing to verify it with
  'failed',
  'cancelled',
]);

export const approvalDecision = pgEnum('approval_decision', ['pending', 'approved', 'rejected', 'expired', 'delegated']);

export const importSource = pgEnum('import_source', ['upload', 'sftp', 'blob', 'api_pull', 'db_read', 'push', 'seed']);

export const importStatus = pgEnum('import_status', ['running', 'completed', 'partial', 'failed']);

export const mappingStatus = pgEnum('mapping_status', ['draft', 'active', 'archived']);

export const jobStatus = pgEnum('job_status', ['pending', 'claimed', 'done', 'failed', 'dead']);

export const callOutcome = pgEnum('call_outcome', [
  'completed_confirmed',
  'not_completed',
  'needs_help',
  'no_answer',
  'busy',
  'wrong_number',
  'failed',
]);

export const usageKind = pgEnum('usage_kind', [
  'whatsapp_conversation',
  'whatsapp_message',
  'ai_call',
  'voice_minute',
  'case_created',
  'case_resolved',
  'action_executed',
]);
