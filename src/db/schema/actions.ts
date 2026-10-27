import { index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actionStatus, actionType, approvalDecision, channel } from './enums';
import { cases } from './cases';
import { employees } from './employees';
import { tenants, users } from './tenants';

export type PreCheckResult = { name: string; passed: boolean; detail?: string };

/**
 * Real work performed in the customer's HRMS on someone's behalf.
 *
 * Two rules are enforced here rather than trusted to callers: nothing executes
 * without an explicit request (and approval where configured), and nothing
 * executes twice — `idempotencyKey` is unique.
 */
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    type: actionType('type').notNull(),
    status: actionStatus('status').notNull().default('draft'),

    /** What the action needs: dates, leave type, half-day, reason. */
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
    preChecks: jsonb('pre_checks').$type<PreCheckResult[]>().notNull().default([]),

    /** Who asked for it, in the employee's own words, and where that came from. */
    requestedVia: channel('requested_via'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    /** Same key for the same intent, so retries and double taps cannot duplicate. */
    idempotencyKey: text('idempotency_key').notNull(),

    connector: text('connector'),
    /** The HRMS's own reference, which is the proof the action happened. */
    hrmsReference: text('hrms_reference'),
    hrmsResponse: jsonb('hrms_response').$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** Set when execution returned nothing verifiable and we must read it back. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('actions_idempotency_key').on(t.tenantId, t.idempotencyKey),
    index('actions_case_idx').on(t.caseId),
    index('actions_status_idx').on(t.tenantId, t.status),
  ],
);

/** One approval request; an action may need several in order. */
/**
 * Whoever approves an employee's leave or regularisation: found from the
 * employee's manager mobile when the file has one, else their manager code. Known
 * by number, because a manager may not be in the attendance file at all.
 */
export const managers = pgTable(
  'managers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    mobileE164: text('mobile_e164').notNull(),
    fullName: text('full_name').notNull(),
    /** Set when the manager is also an employee in the file. */
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    /** How approval requests reach them: 'whatsapp' or 'voice'. */
    preferredChannel: text('preferred_channel').$type<'whatsapp' | 'voice'>().notNull().default('whatsapp'),
    /** On a call: 'keypad' or 'agent'; null follows the customer's setting. */
    callMode: text('call_mode').$type<'keypad' | 'agent' | null>(),
    /** 'automatic' sends a request the moment it exists; 'manual' waits for HR to send it. */
    operatingMode: text('operating_mode').$type<'automatic' | 'manual'>().notNull().default('automatic'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('managers_tenant_mobile_key').on(t.tenantId, t.mobileE164)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actions.id, { onDelete: 'cascade' }),
    /** Whoever must decide: usually the reporting manager. */
    approverEmployeeId: uuid('approver_employee_id').references(() => employees.id, { onDelete: 'set null' }),
    approverUserId: uuid('approver_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The manager asked, by number - who may not be an employee in the file at all. */
    approverManagerId: uuid('approver_manager_id').references(() => managers.id, { onDelete: 'set null' }),
    /** When it went to them; null while it waits for HR to send it (a manager set to manual). */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sequence: smallint('sequence').notNull().default(1),

    decision: approvalDecision('decision').notNull().default('pending'),
    channel: channel('channel').notNull().default('whatsapp'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    note: text('note'),
    nudges: smallint('nudges').notNull().default(0),
    /** After this, escalate per the tenant's approval chain. */
    timeoutAt: timestamp('timeout_at', { withTimezone: true }),
    escalatedTo: text('escalated_to'),
    delegatedToEmployeeId: uuid('delegated_to_employee_id'),
  },
  (t) => [
    index('approvals_action_idx').on(t.actionId, t.sequence),
    index('approvals_pending_idx').on(t.tenantId, t.decision, t.timeoutAt),
  ],
);
