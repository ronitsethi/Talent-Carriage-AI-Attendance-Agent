import { index, jsonb, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { users } from './tenants';

/**
 * A customer's own policy documents, and the passages the agent answers from.
 *
 * Kept per customer like everything else: one employer's leave policy must never
 * surface on another's call, and row-level security enforces that in the
 * database rather than in the code that queries it.
 */
export const policyDocuments = pgTable(
  'policy_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    /** attendance | leave | overtime | exit | other - shown, not used to filter. */
    topic: text('topic').notNull().default('other'),
    status: text('status').notNull().default('processing'), // processing | ready | failed
    error: text('error'),
    /** The whole extracted text, kept so a document can be re-split later. */
    content: text('content'),
    pageCount: text('page_count'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp('ready_at', { withTimezone: true }),
  },
  (t) => [index('policy_documents_tenant_idx').on(t.tenantId, t.status)],
);

/** One passage of one document, with the embedding the search runs against. */
export const policyPassages = pgTable(
  'policy_passages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => policyDocuments.id, { onDelete: 'cascade' }),
    ordinal: text('ordinal').notNull(),
    text: text('text').notNull(),
    /** text-embedding-3-small. */
    embedding: vector('embedding', { dimensions: 1536 }),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (t) => [index('policy_passages_tenant_idx').on(t.tenantId)],
);
