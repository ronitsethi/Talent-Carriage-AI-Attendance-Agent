import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './tenants';

/** The columns of a leave balance file the platform reads, by their heading in the customer's file. */
export type LeaveFieldMap = {
  employeeCode: string;
  leaveType: string;
  balance: string;
  leaveName?: string | null;
  pending?: string | null;
  balanceAfterPending?: string | null;
};

/** What a leave balance upload found. */
export type LeaveReport = {
  rows: number;
  /** Employees whose balances were replaced. */
  employees: number;
  balances: number;
  /** Codes in the file with no employee of that code. */
  unmatched: string[];
  /** Rows with no leave type or no balance, so nothing could be kept. */
  skipped: number;
  leaveTypes: string[];
  /** Leave types not in the code table on Mapping, so which leave they are is not known. */
  unexplained?: string[];
  /** Leave types mapped only as "Leave approved", with no kind of leave. */
  untyped?: string[];
};

/** A leave balance mapping filled in from a sample file, waiting for HR to check it and save. */
export type LeaveDraft = { fieldMap: Partial<LeaveFieldMap>; columns: string[]; filename: string };

/**
 * How one customer's leave balance file reads, set up on Mapping like the
 * attendance and payroll mappings. `fieldMap` is null until it is first saved;
 * `draft` is a sample read in and not saved yet.
 */
export const leaveBalanceProfiles = pgTable('leave_balance_profiles', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  fieldMap: jsonb('field_map').$type<LeaveFieldMap>(),
  columns: jsonb('columns').$type<string[]>().notNull().default([]),
  draft: jsonb('draft').$type<LeaveDraft>(),
  savedAt: timestamp('saved_at', { withTimezone: true }),
  savedBy: uuid('saved_by').references(() => users.id, { onDelete: 'set null' }),
});

/** One leave balance file. Each replaces the balances of everyone in it; the file itself is not kept. */
export const leaveBalanceUploads = pgTable(
  'leave_balance_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    filename: text('filename'),
    report: jsonb('report').$type<LeaveReport>(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('leave_balance_uploads_tenant_idx').on(t.tenantId, t.uploadedAt)],
);
