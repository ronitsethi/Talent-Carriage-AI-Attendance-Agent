import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    empCode: text('emp_code').notNull(),
    fullName: text('full_name').notNull(),
    /** Digits only, country code included: 919876543210. This is the WhatsApp id. */
    mobileE164: text('mobile_e164'),
    mobileRaw: text('mobile_raw'),
    email: text('email'),

    department: text('department'),
    branch: text('branch'),
    location: text('location'),
    designation: text('designation'),
    shiftCode: text('shift_code'),
    calendarCode: text('calendar_code'),

    /** Resolved reporting manager, plus whatever the source file actually gave us. */
    managerEmployeeId: uuid('manager_employee_id'),
    managerRef: text('manager_ref'),
    managerMobileE164: text('manager_mobile_e164'),

    dateOfJoining: date('date_of_joining'),
    exitDate: date('exit_date'),
    employmentStatus: text('employment_status'),

    language: text('language'),
    whatsappOptOut: boolean('whatsapp_opt_out').notNull().default(false),
    callOptOut: boolean('call_opt_out').notNull().default(false),
    consentAt: timestamp('consent_at', { withTimezone: true }),

    /** The source row as imported, for tracing any mapping question later. */
    sourceRow: jsonb('source_row').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('employees_tenant_code_key').on(t.tenantId, t.empCode),
    index('employees_tenant_mobile_idx').on(t.tenantId, t.mobileE164),
    index('employees_manager_idx').on(t.managerEmployeeId),
  ],
);

/** Every change to an employee record, so a wrong number can be traced to its import. */
export const employeeHistory = pgTable(
  'employee_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    source: text('source').notNull(), // import id, user id, or 'system'
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('employee_history_employee_idx').on(t.employeeId, t.changedAt)],
);

/**
 * Shifts carry the working-day pattern, so weekly offs are known even when the
 * attendance file does not spell them out.
 */
export const shifts = pgTable(
  'shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    startTime: time('start_time'),
    endTime: time('end_time'),
    /** 0 = Sunday ... 6 = Saturday. */
    weeklyOffDays: jsonb('weekly_off_days').$type<number[]>().notNull().default([0]),
    minMinutesFullDay: integer('min_minutes_full_day'),
    minMinutesHalfDay: integer('min_minutes_half_day'),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('shifts_tenant_code_key').on(t.tenantId, t.code)],
);

export const calendars = pgTable(
  'calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('calendars_tenant_code_key').on(t.tenantId, t.code)],
);

export const calendarDays = pgTable(
  'calendar_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    calendarId: uuid('calendar_id')
      .notNull()
      .references(() => calendars.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    kind: text('kind').notNull(), // holiday | optional_holiday | non_working
    name: text('name'),
  },
  (t) => [uniqueIndex('calendar_days_key').on(t.calendarId, t.day)],
);

/** Leave balances as last read from the HRMS, so the agent can answer without a live call. */
export const leaveBalances = pgTable(
  'leave_balances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    leaveType: text('leave_type').notNull(),
    balanceDays: smallint('balance_days').notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('leave_balances_key').on(t.employeeId, t.leaveType)],
);
