import { boolean, date, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { attendanceMeaning, caseStatus, replyIntent } from './enums';
import { employees } from './employees';
import { imports } from './mapping';
import { tenants } from './tenants';

/**
 * A case is one employee and one dated gap, followed until it is explained.
 *
 * Chaining rule: an employee may have many cases open at once. Each is asked on
 * its own (subject to the outstanding-question cap), and an unanswered case is
 * never reminded — it simply waits. When the employee answers one, that case
 * moves through the flowchart and the next pending date is asked immediately.
 */
export const cases = pgTable(
  'cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    attDate: date('att_date').notNull(),

    meaning: attendanceMeaning('meaning').notNull(),
    rawStatus: text('raw_status'),
    status: caseStatus('status').notNull().default('queued'),

    /** Detected, and whether it has been asked yet (cap may hold it back). */
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    /** The outbound first-step message, so a button tap maps back to this case. */
    firstMessageId: uuid('first_message_id'),

    answeredAt: timestamp('answered_at', { withTimezone: true }),
    replyOption: smallint('reply_option'),
    replyIntent: replyIntent('reply_intent'),
    replyText: text('reply_text'),
    aiUsed: boolean('ai_used').notNull().default(false),

    /** Escalation clocks, set only once a case has been answered. */
    followUpDueAt: timestamp('follow_up_due_at', { withTimezone: true }),
    followUpSentAt: timestamp('follow_up_sent_at', { withTimezone: true }),
    followUpReply: text('follow_up_reply'),
    callDueAt: timestamp('call_due_at', { withTimezone: true }),
    callAttempts: integer('call_attempts').notNull().default(0),

    /** Set when the day was explained by later data rather than by a reply. */
    closedByRevision: boolean('closed_by_revision').notNull().default(false),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    needsHrReason: text('needs_hr_reason'),
    assignedToUserId: uuid('assigned_to_user_id'),
    error: text('error'),

    detectedByImportId: uuid('detected_by_import_id').references(() => imports.id, { onDelete: 'set null' }),
    /** Anything the conversation needs to remember for this case. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One case per employee per date: re-running a check can never duplicate. */
    uniqueIndex('cases_employee_date_key').on(t.tenantId, t.employeeId, t.attDate),
    index('cases_tenant_status_idx').on(t.tenantId, t.status, t.attDate),
    index('cases_employee_open_idx').on(t.employeeId, t.status, t.attDate),
    index('cases_follow_up_idx').on(t.tenantId, t.followUpDueAt),
    index('cases_call_due_idx').on(t.tenantId, t.callDueAt),
  ],
);

/** Each run of the daily check, so HR can see what the agent did and when. */
export const detectionRuns = pgTable(
  'detection_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    runFor: date('run_for').notNull(),
    trigger: text('trigger').notNull(), // schedule | manual | import | catch_up
    dryRun: boolean('dry_run').notNull().default(false),
    gapsFound: integer('gaps_found').notNull().default(0),
    casesCreated: integer('cases_created').notNull().default(0),
    casesQueued: integer('cases_queued').notNull().default(0),
    messagesSent: integer('messages_sent').notNull().default(0),
    skipped: jsonb('skipped').$type<Record<string, number>>().notNull().default({}),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('detection_runs_tenant_idx').on(t.tenantId, t.startedAt)],
);
