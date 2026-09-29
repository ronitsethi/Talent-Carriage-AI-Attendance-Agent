import type { FieldMap } from '@/db/schema/mapping';
import { combineSessions, type Meaning } from './meanings';
import type { SourceTable } from './source';
import { applyTransforms, normaliseIndianMobile, type TransformName } from './transforms';

/** Our internal field names. A profile points source columns at these. */
export const PLATFORM_FIELDS = [
  'employee_code',
  'employee_name',
  'mobile',
  /** Only for row-per-day files; column-per-day files carry the status in the day columns. */
  'attendance_status',
  'email',
  'department',
  'branch',
  'location',
  'designation',
  'shift_code',
  'calendar_code',
  'manager_ref',
  'manager_mobile',
  'date_of_joining',
  'exit_date',
  'employment_status',
  'language',
] as const;
export type PlatformField = (typeof PLATFORM_FIELDS)[number];

export const REQUIRED_FIELDS: PlatformField[] = ['employee_code', 'employee_name', 'mobile'];

export type CodeRule = { meaning: Meaning; chase: boolean | null };
export type CodeLookup = Map<string, CodeRule>;

export type MappedDay = {
  date: string;
  rawStatus: string;
  firstHalf: string | null;
  secondHalf: string | null;
  meaning: Meaning;
  chaseOverride: boolean | null;
  /** Codes with no mapping. The day becomes `unknown` and is never chased. */
  unmapped: string[];
};

export type MappedEmployee = {
  empCode: string;
  fullName: string;
  mobileRaw: string | null;
  mobileE164: string | null;
  email: string | null;
  department: string | null;
  branch: string | null;
  location: string | null;
  designation: string | null;
  shiftCode: string | null;
  calendarCode: string | null;
  managerRef: string | null;
  managerMobileE164: string | null;
  dateOfJoining: string | null;
  exitDate: string | null;
  employmentStatus: string | null;
  language: string | null;
  sourceRow: Record<string, unknown>;
};

export type MappedRecord = { employee: MappedEmployee; days: MappedDay[] };

export type ApplyResult = {
  records: MappedRecord[];
  dayColumns: { column: string; date: string }[];
  rejected: { row: number; employeeCode?: string; reason: string }[];
  unmapped: Record<string, number>;
  meaningCounts: Record<string, number>;
};

function readField(row: Record<string, unknown>, spec: FieldMap['fields'][string] | undefined): string | null {
  if (!spec?.columns?.length) return null;
  const parts: string[] = [];
  for (const column of spec.columns) {
    const raw = row[column];
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim();
    if (value) parts.push(value);
  }
  if (!parts.length) return null;
  const joined = parts.join(spec.join ?? ' ');
  const out = applyTransforms(joined, spec.transform as TransformName[] | undefined).trim();
  return out === '' ? null : out;
}

/** Accepts 2026-08-18, 18-08-2026, 18/08/2026 and "01 Jan 2024". */
function parseDate(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const dmy = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(trimmed);
  if (dmy) return iso(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/.exec(trimmed);
  if (named) {
    const month = months.indexOf(named[2]!.slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return iso(Number(named[3]), month, Number(named[1]));
  }
  return null;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Works out which columns are day columns, e.g. `1 / 8 | Sat`.
 *
 * A register usually omits the year, so it comes from the report run date: if a
 * column's month is after the run month, the register belongs to the previous
 * year (a December register pulled in January).
 */
export function resolveDayColumns(
  columns: string[],
  layout: Extract<FieldMap['dateLayout'], { kind: 'column_per_day' }>,
  runDate?: { month: number; year: number } | null,
): { column: string; date: string }[] {
  const pattern = new RegExp(layout.headerPattern);
  const out: { column: string; date: string }[] = [];

  for (const column of columns) {
    const match = pattern.exec(column);
    if (!match) continue;
    const groups = (match.groups ?? {}) as Record<string, string | undefined>;
    const day = Number(groups.day ?? match[1]);
    const month = Number(groups.month ?? match[2]);
    if (!day || !month) continue;

    let year: number;
    if (groups.year) year = Number(groups.year);
    else if (layout.yearFrom === 'fixed' && layout.year) year = layout.year;
    else if (runDate) year = month > runDate.month ? runDate.year - 1 : runDate.year;
    else year = new Date().getFullYear();

    out.push({ column, date: iso(year, month, day) });
  }
  return out;
}

function lookupCode(code: string, codes: CodeLookup): CodeRule | null {
  const key = code.trim().toUpperCase();
  return codes.get(key) ?? null;
}

/**
 * Turns one cell into a meaning.
 *
 * The whole cell is looked up first, so a tenant can map `P|A` explicitly. Only
 * if that misses do we split it and combine the halves, which is what lets a
 * tenant map just `P` and `A` and have every combination work.
 */
export function resolveStatus(
  rawStatus: string,
  layout: FieldMap['statusLayout'],
  codes: CodeLookup,
): { meaning: Meaning; firstHalf: string | null; secondHalf: string | null; chaseOverride: boolean | null; unmapped: string[] } {
  const raw = rawStatus.trim();
  const whole = lookupCode(raw, codes);
  if (whole) {
    return { meaning: whole.meaning, firstHalf: null, secondHalf: null, chaseOverride: whole.chase, unmapped: [] };
  }

  if (layout.kind === 'two_session') {
    const [firstRaw, secondRaw] = raw.split(layout.separator).map((p) => p.trim());
    const first = firstRaw ? lookupCode(firstRaw, codes) : null;
    const second = secondRaw ? lookupCode(secondRaw, codes) : first;
    const unmapped: string[] = [];
    if (firstRaw && !first) unmapped.push(firstRaw.toUpperCase());
    if (secondRaw && secondRaw !== firstRaw && !second) unmapped.push(secondRaw.toUpperCase());

    if (!first || !second) {
      return {
        meaning: 'unknown',
        firstHalf: firstRaw ?? null,
        secondHalf: secondRaw ?? null,
        chaseOverride: null,
        unmapped: unmapped.length ? unmapped : [raw.toUpperCase()],
      };
    }
    return {
      meaning: combineSessions(first.meaning, second.meaning),
      firstHalf: firstRaw ?? null,
      secondHalf: secondRaw ?? null,
      // An explicit override on either half still applies.
      chaseOverride: first.chase ?? second.chase ?? null,
      unmapped: [],
    };
  }

  return { meaning: 'unknown', firstHalf: null, secondHalf: null, chaseOverride: null, unmapped: [raw.toUpperCase()] };
}

/** Punch-time layouts: no status codes at all, just in and out times. */
function resolvePunches(inTime: string | null, outTime: string | null): Meaning {
  if (!inTime && !outTime) return 'absent_full';
  if (!inTime || !outTime) return 'missed_punch';
  return 'present';
}

/**
 * Applies a mapping profile to one sheet, producing employees and their days in
 * the platform's own vocabulary. Nothing is written to the database here, which
 * is what lets the mapping studio preview a file safely.
 */
export function applyProfile(
  table: SourceTable,
  fieldMap: FieldMap,
  codes: CodeLookup,
  opts: { runDate?: { month: number; year: number } | null } = {},
): ApplyResult {
  const rejected: ApplyResult['rejected'] = [];
  const unmapped: Record<string, number> = {};
  const meaningCounts: Record<string, number> = {};
  const byEmployee = new Map<string, MappedRecord>();

  const dayColumns =
    fieldMap.dateLayout.kind === 'column_per_day'
      ? resolveDayColumns(table.columns, fieldMap.dateLayout, opts.runDate)
      : [];

  const countMeaning = (m: Meaning) => {
    meaningCounts[m] = (meaningCounts[m] ?? 0) + 1;
  };
  const countUnmapped = (codesSeen: string[]) => {
    for (const c of codesSeen) unmapped[c] = (unmapped[c] ?? 0) + 1;
  };

  table.rows.forEach((row, index) => {
    const empCode = readField(row, fieldMap.fields.employee_code);
    const fullName = readField(row, fieldMap.fields.employee_name);
    if (!empCode && !fullName) return; // blank or spacer row

    if (!empCode) {
      rejected.push({ row: index + 2, reason: 'No employee code' });
      return;
    }
    if (!fullName) {
      rejected.push({ row: index + 2, employeeCode: empCode, reason: 'No employee name' });
      return;
    }

    const mobileRaw = readField(row, fieldMap.fields.mobile);
    const employee: MappedEmployee = {
      empCode,
      fullName,
      mobileRaw,
      mobileE164: mobileRaw ? normaliseIndianMobile(mobileRaw) : null,
      email: readField(row, fieldMap.fields.email),
      department: readField(row, fieldMap.fields.department),
      branch: readField(row, fieldMap.fields.branch),
      location: readField(row, fieldMap.fields.location),
      designation: readField(row, fieldMap.fields.designation),
      shiftCode: readField(row, fieldMap.fields.shift_code),
      calendarCode: readField(row, fieldMap.fields.calendar_code),
      managerRef: readField(row, fieldMap.fields.manager_ref),
      managerMobileE164: (() => {
        const m = readField(row, fieldMap.fields.manager_mobile);
        return m ? normaliseIndianMobile(m) : null;
      })(),
      dateOfJoining: parseDate(readField(row, fieldMap.fields.date_of_joining)),
      exitDate: parseDate(readField(row, fieldMap.fields.exit_date)),
      employmentStatus: readField(row, fieldMap.fields.employment_status),
      language: readField(row, fieldMap.fields.language),
      sourceRow: row,
    };

    const record = byEmployee.get(empCode) ?? { employee, days: [] };
    // A later row for the same employee refreshes their details (row-per-day files).
    record.employee = { ...record.employee, ...employee };

    if (fieldMap.dateLayout.kind === 'column_per_day') {
      for (const { column, date } of dayColumns) {
        const cell = row[column];
        if (cell === null || cell === undefined || String(cell).trim() === '') continue;
        const rawStatus = String(cell).trim();
        const resolved = resolveStatus(rawStatus, fieldMap.statusLayout, codes);
        countMeaning(resolved.meaning);
        countUnmapped(resolved.unmapped);
        record.days.push({ date, rawStatus, ...resolved });
      }
    } else {
      const date = parseDate(readField(row, { columns: [fieldMap.dateLayout.column] }));
      if (!date) {
        rejected.push({ row: index + 2, employeeCode: empCode, reason: 'Unreadable date' });
      } else if (fieldMap.statusLayout.kind === 'punch_times') {
        const inTime = readField(row, { columns: [fieldMap.statusLayout.inColumn] });
        const outTime = readField(row, { columns: [fieldMap.statusLayout.outColumn] });
        const meaning = resolvePunches(inTime, outTime);
        countMeaning(meaning);
        record.days.push({
          date,
          rawStatus: [inTime, outTime].filter(Boolean).join(' - ') || 'no punches',
          firstHalf: inTime,
          secondHalf: outTime,
          meaning,
          chaseOverride: null,
          unmapped: [],
        });
      } else {
        const rawStatus = readField(row, fieldMap.fields.attendance_status ?? { columns: [] });
        if (!rawStatus) {
          rejected.push({ row: index + 2, employeeCode: empCode, reason: 'No attendance status' });
        } else {
          const resolved = resolveStatus(rawStatus, fieldMap.statusLayout, codes);
          countMeaning(resolved.meaning);
          countUnmapped(resolved.unmapped);
          record.days.push({ date, rawStatus, ...resolved });
        }
      }
    }

    byEmployee.set(empCode, record);
  });

  // The same employee can appear on more than one row - a register split by
  // department, a repeated header, a file two months were pasted into. Left
  // alone that gives one person the same date twice, and Postgres rejects the
  // whole batch with "ON CONFLICT DO UPDATE command cannot affect row a second
  // time", which says nothing about the file. The later row wins, as it does
  // for the employee's own details.
  const records = [...byEmployee.values()].map((record) => {
    const byDate = new Map<string, MappedDay>();
    for (const day of record.days) byDate.set(day.date, day);
    return byDate.size === record.days.length ? record : { ...record, days: [...byDate.values()] };
  });

  return { records, dayColumns, rejected, unmapped, meaningCounts };
}
