import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { attendanceMeaning, importSource, importStatus, mappingStatus } from './enums';
import { tenants, users } from './tenants';

/** How one customer's columns are read. Versioned, so a change is traceable and reversible. */
export type FieldMap = {
  /** Our field -> one or more source columns. Several columns are joined with `join`. */
  fields: Record<string, { columns: string[]; join?: string; transform?: string[] }>;
  /** How dates are laid out in the source. */
  dateLayout:
    | { kind: 'column_per_day'; headerPattern: string; yearFrom: 'filter_sheet' | 'fixed'; year?: number }
    | { kind: 'row_per_day'; column: string; format?: string };
  /** Where the attendance status sits, and how to split it. */
  statusLayout:
    | { kind: 'single' }
    | { kind: 'two_session'; separator: string }
    | { kind: 'punch_times'; inColumn: string; outColumn: string };
  sheetHint?: string;
};

export const mappingProfiles = pgTable(
  'mapping_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    status: mappingStatus('status').notNull().default('draft'),
    /** Which HRMS this came from, for the reusable profile library. */
    hrmsHint: text('hrms_hint'),
    fieldMap: jsonb('field_map').$type<FieldMap>().notNull(),
    /**
     * What the uploaded file looked like: its columns, a few values from each,
     * and the codes found. Kept so the mapping screen can be reopened and
     * corrected without asking for the file again.
     */
    detected: jsonb('detected').$type<Record<string, unknown>>(),
    /**
     * The uploaded file itself, base64, kept only while a draft is being
     * corrected. It is there so the file that was mapped is the file that gets
     * imported - asking for it a second time is how the two drift apart.
     * Cleared when the mapping is saved.
     */
    sourceFile: text('source_file'),
    sourceFilename: text('source_filename'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** Set when a newer version replaced this one. */
    supersededBy: uuid('superseded_by'),
  },
  (t) => [
    uniqueIndex('mapping_profiles_version_key').on(t.tenantId, t.name, t.version),
    index('mapping_profiles_active_idx').on(t.tenantId, t.status),
  ],
);

/** One customer code (A|A, Ab, 0.5, CL) mapped to one canonical meaning. */
export const codeMappings = pgTable(
  'code_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => mappingProfiles.id, { onDelete: 'cascade' }),
    /** Stored uppercase and trimmed. */
    code: text('code').notNull(),
    meaning: attendanceMeaning('meaning').notNull(),
    /** Overrides the default for this meaning; null means "use the default". */
    chase: boolean('chase'),
    notes: text('notes'),
    /** True when a model proposed this and a human has not confirmed it yet. */
    aiSuggested: boolean('ai_suggested').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('code_mappings_key').on(t.profileId, t.code)],
);

/**
 * Codes seen in real data with no mapping. These never trigger a message; they
 * are surfaced so an admin can decide what they mean.
 */
export const unmappedCodes = pgTable(
  'unmapped_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    sampleEmployeeCode: text('sample_employee_code'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('unmapped_codes_key').on(t.tenantId, t.code)],
);

export type ImportReport = {
  rowsRead: number;
  employeesSeen: number;
  employeesCreated: number;
  employeesUpdated: number;
  daysImported: number;
  rejected: { row: number; employeeCode?: string; reason: string }[];
  unmappedCodes: Record<string, number>;
  meaningCounts: Record<string, number>;
};

export const imports = pgTable(
  'imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    source: importSource('source').notNull(),
    status: importStatus('status').notNull().default('running'),
    profileId: uuid('profile_id').references(() => mappingProfiles.id, { onDelete: 'set null' }),
    filename: text('filename'),
    /** Blob path or connector reference, for re-running an import. */
    sourceRef: text('source_ref'),
    dateFrom: text('date_from'),
    dateTo: text('date_to'),
    report: jsonb('report').$type<ImportReport>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('imports_tenant_idx').on(t.tenantId, t.startedAt)],
);
