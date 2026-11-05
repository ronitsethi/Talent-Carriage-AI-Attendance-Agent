import { relations } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenantStatus, userRole } from './enums';

/** How one follow-up level reaches people. Null keeps the employee's own setting. */
export type FollowUpContact = { channel: 'whatsapp' | 'voice' | null; callMode: 'keypad' | 'agent' | null };

/** One tenant = one employer that bought the product. */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: tenantStatus('status').notNull().default('onboarding'),
    licensedHeadcount: integer('licensed_headcount'),
    logoUrl: text('logo_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenants_slug_key').on(t.slug)],
);

/**
 * Everything an employer can tune. Defaults here are the agreed demo behaviour,
 * so a new tenant works sensibly before anyone touches the settings screen.
 */
export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  /**
   * manual    - HR contacts people from the dashboard and Cases. This is the
   *             default, so a newly configured customer can never message anyone
   *             by surprise.
   * automatic - with CSV upload only: each upload offers to send everything due,
   *             starting `sendDelayMinutes` later. Nothing goes out without an upload.
   */
  operatingMode: text('operating_mode').notNull().default('manual'),
  sendDelayMinutes: integer('send_delay_minutes').notNull().default(60),
  /**
   * The default for `employees.callMode`: 'keypad' or 'agent'. Keypad is the
   * default because it works on any line, needs no speech recognition, and
   * costs a fraction of a spoken conversation.
   */
  callMode: text('call_mode').notNull().default('keypad'),
  /**
   * The voice the talking agent speaks in, and how fast. Per customer, because
   * which voice sounds right is a matter of taste and of who is being called -
   * a factory floor and a head office do not want the same thing.
   */
  agentVoice: text('agent_voice').notNull().default('simran_enhi_customer'),
  agentVoicePace: numeric('agent_voice_pace', { precision: 3, scale: 2 }).notNull().default('0.95'),
  /** Master switch: false means cases are created but nothing is ever delivered. */
  sendingEnabled: boolean('sending_enabled').notNull().default(false),

  /** Canonical meanings this tenant wants chased, beyond the always-chased ones. */
  chaseMeanings: jsonb('chase_meanings').$type<string[]>().notNull().default([]),
  /** Ignore lateness / shortfall below these, in minutes. */
  lateGraceMinutes: integer('late_grace_minutes').notNull().default(15),
  shortHoursGraceMinutes: integer('short_hours_grace_minutes').notNull().default(30),

  /** Not in use for now: nothing reads these, and Settings no longer shows them. */
  quietHoursStart: time('quiet_hours_start').notNull().default('20:00'),
  quietHoursEnd: time('quiet_hours_end').notNull().default('09:00'),
  messageOnNonWorkingDays: boolean('message_on_non_working_days').notNull().default(false),

  /** Skip people in their first N days, and anyone who has left. */
  excludeFirstDays: integer('exclude_first_days').notNull().default(0),
  excludeExitedEmployees: boolean('exclude_exited_employees').notNull().default(true),
  excludedDepartments: jsonb('excluded_departments').$type<string[]>().notNull().default([]),
  excludedEmployeeCodes: jsonb('excluded_employee_codes').$type<string[]>().notNull().default([]),

  /**
   * How many unanswered first-step questions one employee may have outstanding.
   * 0 = unlimited: every absent date is asked as it is detected, and they pile
   * up until the employee starts answering. With a cap, the extra dates sit in
   * `queued` and are asked one at a time as earlier ones are answered.
   */
  maxOutstandingQuestions: integer('max_outstanding_questions').notNull().default(0),
  /** Send the "N days still pending" summary when a date is answered. */
  sendBacklogSummary: boolean('send_backlog_summary').notNull().default(true),

  /** Escalation, which applies only to dates the employee has answered. */
  /**
   * How many follow-ups one date gets, a day apart. The last warns of loss of pay
   * and moves the case to the manager.
   */
  maxFollowUps: integer('max_follow_ups').notNull().default(2),
  /** One entry per follow-up level, the first for Follow-up 1. */
  followUpContacts: jsonb('follow_up_contacts').$type<FollowUpContact[]>().notNull().default([]),
  callRetries: smallint('call_retries').notNull().default(2),
  approvalTimeoutHours: integer('approval_timeout_hours').notNull().default(24),
  approvalEscalatesTo: text('approval_escalates_to').notNull().default('hr'), // hr | skip_level | none

  /** Channel used for employees with no explicit preference. */
  defaultChannel: text('default_channel').notNull().default('whatsapp'),
  /**
   * How many days after the absence the agent makes contact. 1 means an absence
   * on the 21st is chased on the 22nd - attendance for a day is not final until
   * the day has ended, and some customers' data lands a day later still.
   */
  contactLagDays: integer('contact_lag_days').notNull().default(1),
  /** Stop a single call running forever; 0 means keep going until cleared. */
  maxDatesPerCall: integer('max_dates_per_call').notNull().default(0),
  /** The number calls are placed from, in full international form. */
  callerId: text('caller_id'),
  defaultLanguage: text('default_language').notNull().default('en'),
  languages: jsonb('languages').$type<string[]>().notNull().default(['en']),

  /** Whether the agent may write to the HRMS at all, and with what. */
  /**
   * Where attendance comes from: 'csv' (uploaded files) or 'hrms' (a connected
   * HRMS). With an HRMS the agent offers to apply leave and regularisation itself.
   */
  attendanceSource: text('attendance_source').$type<'csv' | 'hrms'>().notNull().default('csv'),
  actionsEnabled: boolean('actions_enabled').notNull().default(false),
  allowedActions: jsonb('allowed_actions').$type<string[]>().notNull().default([]),
  allowedLeaveTypes: jsonb('allowed_leave_types').$type<string[]>().notNull().default([]),
  conversationalRepliesEnabled: boolean('conversational_replies_enabled').notNull().default(true),
  policyAnswersEnabled: boolean('policy_answers_enabled').notNull().default(false),

  /** Per-tenant model preference; null means the platform default for that task. */
  modelOverrides: jsonb('model_overrides').$type<Record<string, string>>().notNull().default({}),

  signature: text('signature'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Provider credentials and identifiers per tenant. Secrets live in a vault, never here. */
export const tenantChannels = pgTable(
  'tenant_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // whatsapp | voice | sms | email
    provider: text('provider').notNull(), // meta_cloud | plivo | exotel | fake
    /** Display identifier, e.g. the sending number. Safe to show in the portal. */
    identifier: text('identifier'),
    /** Non-secret provider config: phone number id, template names, caller id. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Key Vault references (names, not values). */
    secretRefs: jsonb('secret_refs').$type<Record<string, string>>().notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tenant_channels_kind_key').on(t.tenantId, t.kind, t.provider)],
);

/** Staff logins: Talent Carriage users have a null tenantId and see everything. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRole('role').notNull(),
    passwordHash: text('password_hash'),
    /** Optional narrowing for hr_user: only these departments. */
    departmentScope: jsonb('department_scope').$type<string[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const tenantsRelations = relations(tenants, ({ one, many }) => ({
  settings: one(tenantSettings, { fields: [tenants.id], references: [tenantSettings.tenantId] }),
  channels: many(tenantChannels),
  users: many(users),
}));
