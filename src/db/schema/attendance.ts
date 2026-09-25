import { boolean, date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { attendanceMeaning } from './enums';
import { employees } from './employees';
import { imports } from './mapping';
import { tenants } from './tenants';

/**
 * One row per employee per day, after mapping. `rawStatus` is kept verbatim so a
 * disputed case can always be traced back to what the HRMS actually said.
 */
export const attendanceDays = pgTable(
  'attendance_days',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    attDate: date('att_date').notNull(),

    rawStatus: text('raw_status'),
    firstHalf: text('first_half'),
    secondHalf: text('second_half'),
    meaning: attendanceMeaning('meaning').notNull(),

    workedMinutes: integer('worked_minutes'),
    lateMinutes: integer('late_minutes'),
    earlyOutMinutes: integer('early_out_minutes'),
    shiftCode: text('shift_code'),
    /** True when the shift or calendar says this was not a working day. */
    isWorkingDay: boolean('is_working_day').notNull().default(true),

    importId: uuid('import_id').references(() => imports.id, { onDelete: 'set null' }),
    /** Bumped when a later import changes this day, which can close an open case. */
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.employeeId, t.attDate] }),
    index('attendance_days_date_idx').on(t.tenantId, t.attDate, t.meaning),
  ],
);
