import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channel, messageDirection, messageKind, messageStatus } from './enums';
import { cases } from './cases';
import { employees } from './employees';
import { tenants } from './tenants';

/**
 * One conversation per employee per channel. It tracks the 24-hour window, which
 * decides whether the next message may be free-form or must be a template, and
 * which case the employee is currently talking about.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    channel: channel('channel').notNull().default('whatsapp'),

    /** Free-form messages are allowed until this moment. */
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),

    /** The case the employee is answering right now, used for free-text replies. */
    activeCaseId: uuid('active_case_id').references(() => cases.id, { onDelete: 'set null' }),
    language: text('language'),
    /** Short-term dialogue state: what the agent last asked, pending confirmations. */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_employee_channel_key').on(t.employeeId, t.channel)],
);

/**
 * Something an employee asked us of their own accord, rather than an answer
 * about an absent date: a call to us, or a WhatsApp chat that is not about a
 * case. A call is one query; a chat is one until it goes quiet for half an hour.
 */
export const queries = pgTable(
  'queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    channel: channel('channel').notNull(),
    /** On a call: 'agent' for the talking agent, 'keypad' for Plivo's spoken menu. */
    callStyle: text('call_style'),
    providerCallId: text('provider_call_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** A call's turns; a chat's are its messages, which carry this query's id. */
    transcript: jsonb('transcript').$type<{ role: 'agent' | 'employee'; text: string; at: string; heard?: string }[]>(),
    /** Where the call's audio is kept - see `recordings.ts`. */
    recordingUri: text('recording_uri'),
    /** What they asked, and what they were told, across the whole query. */
    summaryQueries: text('summary_queries'),
    summaryReply: text('summary_reply'),
    summarisedAt: timestamp('summarised_at', { withTimezone: true }),
    /**
     * Feedback on a call, asked on WhatsApp after it: which question is
     * waiting ('resolved', 'rating', 'comment', or 'done'), and the answers.
     */
    feedbackSentAt: timestamp('feedback_sent_at', { withTimezone: true }),
    feedbackStep: text('feedback_step').$type<'resolved' | 'rating' | 'comment' | 'done'>(),
    feedbackResolved: text('feedback_resolved').$type<'yes' | 'partly' | 'no'>(),
    feedbackRating: text('feedback_rating').$type<'good' | 'okay' | 'poor'>(),
    feedbackComment: text('feedback_comment'),
    feedbackAnsweredAt: timestamp('feedback_answered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('queries_tenant_started_idx').on(t.tenantId, t.startedAt),
    index('queries_employee_open_idx').on(t.employeeId, t.channel, t.lastActivityAt),
  ],
);

/** Every message in and out, including the ones a fake channel only pretended to send. */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    /** Null for messages that belong to the employee rather than one date, e.g. a backlog summary. */
    caseId: uuid('case_id').references(() => cases.id, { onDelete: 'set null' }),
    /** Set when the message is part of a query rather than about a date. */
    queryId: uuid('query_id').references(() => queries.id, { onDelete: 'set null' }),

    direction: messageDirection('direction').notNull(),
    channel: channel('channel').notNull().default('whatsapp'),
    kind: messageKind('kind').notNull(),
    status: messageStatus('status').notNull().default('queued'),

    /** Provider id (WhatsApp wamid), used to de-duplicate retried webhooks. */
    providerMessageId: text('provider_message_id'),
    /** The provider message this one replies to, for mapping a tap to its case. */
    replyToProviderId: text('reply_to_provider_id'),
    waId: text('wa_id'),

    templateName: text('template_name'),
    language: text('language'),
    body: text('body'),
    buttons: jsonb('buttons').$type<{ id: string; title: string }[]>(),
    /** Raw provider payload, kept for audit and debugging. */
    payload: jsonb('payload').$type<Record<string, unknown>>(),

    /** Set when a model generated or interpreted this message. */
    aiModel: text('ai_model'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('messages_provider_id_key').on(t.providerMessageId),
    index('messages_case_idx').on(t.caseId, t.createdAt),
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    index('messages_tenant_idx').on(t.tenantId, t.createdAt),
  ],
);

/** WhatsApp templates per tenant, with their Meta approval state. */
export const templates = pgTable(
  'templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Internal purpose: first_step | follow_up_absent | follow_up_regularisation | ... */
    purpose: text('purpose').notNull(),
    providerName: text('provider_name').notNull(),
    language: text('language').notNull().default('en'),
    bodyPreview: text('body_preview').notNull(),
    variableCount: integer('variable_count').notNull().default(2),
    buttons: jsonb('buttons').$type<{ id: string; title: string }[]>().notNull().default([]),
    approvalStatus: text('approval_status').notNull().default('unknown'), // approved | pending | rejected | unknown
    approvalCheckedAt: timestamp('approval_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('templates_key').on(t.tenantId, t.purpose, t.language)],
);
