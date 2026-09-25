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
