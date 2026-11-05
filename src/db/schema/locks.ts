import { pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './tenants';

/**
 * A month of a customer's attendance made final by an admin. While locked, no
 * upload writes its days, nobody is contacted about it, and its open cases wait
 * as `unresolved`. `month` is YYYY-MM.
 */
export const attendanceLocks = pgTable(
  'attendance_locks',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: uuid('locked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [primaryKey({ name: 'attendance_locks_pk', columns: [t.tenantId, t.month] })],
);

/**
 * The phone lines every call shares, across all customers. A call or an incoming
 * call holds a line from when it is placed until it ends; see `voice/lines.ts`.
 */
export const callLines = pgTable('call_lines', {
  id: smallint('id').primaryKey(),
  holderKind: text('holder_kind').$type<'call' | 'query'>(),
  holderId: uuid('holder_id'),
  takenAt: timestamp('taken_at', { withTimezone: true }),
});
