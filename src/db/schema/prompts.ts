import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './tenants';

/**
 * Saved versions of the AI's editable prompts (AI prompts page, staff only).
 *
 * `tenant_id` null is a version for every customer; set, it is that customer's
 * own. The agent uses the customer's active version, else the all-customers
 * active version, else the original text in `src/lib/prompts/defaults.ts`,
 * which is never stored. At most one version per prompt and scope is active
 * (a partial unique index in migration 0039).
 */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Which prompt: a `PromptKey` from `src/lib/prompts`. */
    prompt: text('prompt').notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    /** 1, 2, 3... per prompt and scope; the original text is version 0. */
    number: integer('number').notNull(),
    body: text('body').notNull(),
    note: text('note'),
    active: boolean('active').notNull().default(false),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Kept as it was when saved, so the history still reads right if the user goes. */
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('prompt_versions_lookup_idx').on(t.prompt, t.tenantId)],
);
