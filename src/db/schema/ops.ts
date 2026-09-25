import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { callOutcome, channel, jobStatus, usageKind } from './enums';
import { cases } from './cases';
import { employees } from './employees';
import { messages } from './messaging';
import { tenants, users } from './tenants';

/**
 * Policy content a tenant's answers must come from. Nothing outside a pack is
 * ever used to answer a policy question.
 */
export const policyPacks = pgTable(
  'policy_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    isActive: boolean('is_active').notNull().default(false),
    /** HR must review sample answers before the pack can go live. */
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policy_packs_key').on(t.tenantId, t.name, t.version)],
);

export const policySources = pgTable(
  'policy_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    packId: uuid('pack_id')
      .notNull()
      .references(() => policyPacks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // document | faq | setting
    title: text('title').notNull(),
    /** Blob path for an uploaded document. */
    uri: text('uri'),
    text: text('text'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('policy_sources_pack_idx').on(t.packId)],
);

/**
 * Retrievable chunks. Keyword search over `tsv` works with no external service;
 * an embedding column can be added later without changing callers.
 */
export const policyChunks = pgTable(
  'policy_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    packId: uuid('pack_id')
      .notNull()
      .references(() => policyPacks.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => policySources.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading'),
    text: text('text').notNull(),
    /** Shown to HR as "this answer came from here". */
    citation: text('citation'),
  },
  (t) => [index('policy_chunks_pack_idx').on(t.packId, t.ordinal)],
);

/** Every model decision, so accuracy can be measured and corrected rather than assumed. */
export const aiDecisions = pgTable(
  'ai_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    task: text('task').notNull(), // classify_reply | answer_policy | suggest_mapping | summarise | voice_turn
    provider: text('provider').notNull(), // openai | anthropic | sarvam | rules | stub
    model: text('model').notNull(),
    inputText: text('input_text'),
    output: jsonb('output').$type<Record<string, unknown>>(),
    confidence: text('confidence'),
    /** True when the primary provider failed and the gateway fell back. */
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    citations: jsonb('citations').$type<string[]>(),

    /** HR review of this decision, which becomes a regression test case. */
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewVerdict: text('review_verdict'), // correct | wrong | unsure
    reviewNote: text('review_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_decisions_tenant_idx').on(t.tenantId, t.createdAt),
    index('ai_decisions_review_idx').on(t.tenantId, t.reviewVerdict),
  ],
);

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),

    provider: text('provider').notNull(), // plivo | exotel | acs | fake
    providerCallId: text('provider_call_id'),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    attempt: smallint('attempt').notNull().default(1),

    status: text('status').notNull().default('queued'), // queued | ringing | in_progress | completed | failed
    outcome: callOutcome('outcome'),
    /** Turn-by-turn, so a spoken conversation is auditable like a chat. */
    transcript: jsonb('transcript').$type<{ role: 'agent' | 'employee'; text: string; at: string }[]>(),
    recordingUri: text('recording_uri'),
    usedKeypadFallback: boolean('used_keypad_fallback').notNull().default(false),
    durationSeconds: integer('duration_seconds'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('calls_case_idx').on(t.caseId), index('calls_tenant_idx').on(t.tenantId, t.startedAt)],
);

/**
 * Postgres-backed job queue. Deliberately simple and visible in SQL; the worker
 * interface is the same one an Azure Service Bus implementation will satisfy.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus('status').notNull().default('pending'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set to make a job unique, e.g. one daily check per tenant per date. */
    dedupeKey: text('dedupe_key'),
    priority: smallint('priority').notNull().default(5),
    attempts: smallint('attempts').notNull().default(0),
    maxAttempts: smallint('max_attempts').notNull().default(5),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_key').on(t.dedupeKey),
    index('jobs_ready_idx').on(t.status, t.runAt, t.priority),
  ],
);

/** Append-only trail: who or what did something, and what it changed. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(), // user | agent | system | employee | manager
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    reason: text('reason'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tenant_idx').on(t.tenantId, t.createdAt),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
  ],
);

/** Metered usage, for billing and fair-use limits. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: usageKind('kind').notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** Provider cost in micro-units of currency, when known. */
    costMicros: bigint('cost_micros', { mode: 'number' }),
    channel: channel('channel'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('usage_events_tenant_idx').on(t.tenantId, t.kind, t.occurredAt)],
);

/** Employee-facing opt-outs and consent, kept separate from the HRMS record. */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // whatsapp_opt_out | whatsapp_opt_in | call_opt_out | consent_given
    source: text('source').notNull(), // employee_message | hr_portal | import
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consent_events_employee_idx').on(t.employeeId, t.createdAt)],
);
