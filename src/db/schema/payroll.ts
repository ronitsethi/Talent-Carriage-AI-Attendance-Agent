import { index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { employees } from './employees';
import { tenants, users } from './tenants';

/** The columns of a payroll file the platform needs to know, by their heading in the customer's file. */
export type PayrollFieldMap = {
  employeeCode: string;
  calendarDays: string;
  paidDays: string;
  gross: string;
  net: string;
  rate?: string | null;
  deductions?: string | null;
  arrears?: string | null;
};

/** What an upload found, checked against the locked attendance. */
export type PayrollReport = {
  rows: number;
  matched: number;
  /** Codes in the file with no employee of that code. */
  unmatched: string[];
  warnings: { empCode: string; name: string | null; text: string }[];
  /** Headings left out: always the sensitive ones, and any HR chose not to keep. */
  dropped: string[];
};

/** A payroll mapping filled in from a sample file, waiting for HR to check it and save. */
export type PayrollDraft = { fieldMap: Partial<PayrollFieldMap>; columns: string[]; excluded: string[]; filename: string };

/**
 * How one customer's payroll file reads, set up on Mapping & import like the
 * attendance mapping: which heading is which of the few columns the platform
 * works with, and which headings are not kept. `fieldMap` is null until it is
 * first saved. `columns` are the headings of the sample it was set up from, for
 * the tick boxes; `draft` is a sample read in and not saved yet.
 */
export const payrollProfiles = pgTable('payroll_profiles', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  fieldMap: jsonb('field_map').$type<PayrollFieldMap>(),
  excluded: jsonb('excluded').$type<string[]>().notNull().default([]),
  columns: jsonb('columns').$type<string[]>().notNull().default([]),
  draft: jsonb('draft').$type<PayrollDraft>(),
  savedAt: timestamp('saved_at', { withTimezone: true }),
  savedBy: uuid('saved_by').references(() => users.id, { onDelete: 'set null' }),
});

/** One payroll file for one month, read with the customer's payroll mapping. A month's payroll goes in once. */
export const payrollUploads = pgTable(
  'payroll_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    filename: text('filename'),
    columns: jsonb('columns').$type<string[]>().notNull().default([]),
    report: jsonb('report').$type<PayrollReport>(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('payroll_uploads_month_key').on(t.tenantId, t.month)],
);

/**
 * One employee's salary for one month. The key figures have columns of their
 * own; every other kept heading is in `fields`, in the file's order.
 */
export const payrollRows = pgTable(
  'payroll_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => payrollUploads.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    employeeId: uuid('employee_id').references(() => employees.id, { onDelete: 'set null' }),
    empCode: text('emp_code').notNull(),
    employeeName: text('employee_name'),
    calendarDays: numeric('calendar_days', { mode: 'number' }),
    paidDays: numeric('paid_days', { mode: 'number' }),
    monthlyRate: numeric('monthly_rate', { mode: 'number' }),
    gross: numeric('gross', { mode: 'number' }),
    deductions: numeric('deductions', { mode: 'number' }),
    net: numeric('net', { mode: 'number' }),
    arrears: numeric('arrears', { mode: 'number' }),
    fields: jsonb('fields').$type<[string, string][]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex('payroll_rows_month_code_key').on(t.tenantId, t.month, t.empCode),
    index('payroll_rows_employee_idx').on(t.employeeId, t.month),
  ],
);
