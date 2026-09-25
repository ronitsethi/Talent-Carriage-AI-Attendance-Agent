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
