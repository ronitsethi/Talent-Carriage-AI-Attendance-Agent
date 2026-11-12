import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { leaveBalanceUploads } from './leave';

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
    /**
     * How this person is contacted: 'whatsapp' or 'voice', or null to follow the
     * customer's defaults (first contact, reminders). Set per employee in the
     * portal only when they need their own; each case keeps the channel it
     * actually went by, so a later change never rewrites that history.
     */
    preferredChannel: text('preferred_channel'),
    /** Channel for the day-2 follow-up; falls back to preferredChannel. */
    followUpChannel: text('follow_up_channel'),
    /**
     * 'manual'    - this person is only contacted when HR does it by hand
     * 'automatic' - contacted when HR sends after an attendance upload
     * null        - follow the customer's default
     */
    operatingMode: text('operating_mode'),
    /**
     * How a call to this person is conducted:
     * 'keypad' - the agent reads the options and they press a key
     * 'agent'  - a spoken conversation; they answer in their own words
     * null     - follow the customer's default
     *
     * Only meaningful when `preferredChannel` is 'voice'. The questions asked
     * and the answers recorded are identical either way; only the delivery
     * differs, which is why this is a separate switch rather than a channel.
     */
    callMode: text('call_mode'),
    /** When this person was last sent a first message, call or reminder about unanswered absences. */
    absenceContactAt: timestamp('absence_contact_at', { withTimezone: true }),
    /** Reminders sent since they last answered; enough of them and the manager is told. */
    absenceReminders: integer('absence_reminders').notNull().default(0),
    whatsappOptOut: boolean('whatsapp_opt_out').notNull().default(false),
    callOptOut: boolean('call_opt_out').notNull().default(false),
    consentAt: timestamp('consent_at', { withTimezone: true }),

    /**
     * Deleted by HR, but kept because their open cases are kept as a record.
     *
     * A deleted employee is invisible: off the dashboard, out of the daily
     * check, and unreachable - nothing is sent to them and nothing they send is
     * acted on. Only their cases remain, read-only, in Follow-up cases. When HR
     * deletes the open cases too there is nothing left to hold, so the row is
     * deleted outright rather than marked.
     *
     * Cleared when an attendance file has them again: the file is the record of
     * who works here, so they are an employee once more and the cases that were
     * kept become live work again.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

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

/**
 * Each employee's leave balance per leave type, so the agent can answer "how
 * many leaves do I have left?" without a live call. It comes from an uploaded
 * leave balance file (`source` upload) or as last read from the HRMS (`hrms`).
 * Half days are kept. `pendingDays` is leave applied and not yet approved, and
 * `balanceAfterPending` what is left once it is.
 */
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
    leaveName: text('leave_name'),
    balanceDays: numeric('balance_days', { mode: 'number' }).notNull(),
    pendingDays: numeric('pending_days', { mode: 'number' }),
    balanceAfterPending: numeric('balance_after_pending', { mode: 'number' }),
    source: text('source').notNull().default('hrms'),
    uploadId: uuid('upload_id').references(() => leaveBalanceUploads.id, { onDelete: 'set null' }),
    asOf: timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('leave_balances_key').on(t.employeeId, t.leaveType)],
);
