import type { FieldMap } from '@/db/schema';
import { ALL_MEANINGS, type Meaning } from './meanings';
import { columnValues, detectRunDate, pickTable, readWorkbook, type SourceTable } from './source';
import { PLATFORM_FIELDS, type PlatformField } from './apply';

/**
 * Reads a customer's file and works out what it is looking at, so somebody can
 * correct the guesses rather than write the mapping from nothing.
 *
 * Every guess here is a suggestion. Nothing is used until a person has seen it
 * and saved it: a column matched by its heading is a coincidence until
 * confirmed, and a code guessed from its letter is worse - mistaking a code is
 * how you telephone four hundred people who were never absent.
 */

export type DetectedColumn = {
  name: string;
  /** A few values as they appear, so a heading can be judged by its contents. */
  samples: string[];
  /** True when the heading looks like a date rather than a property. */
  looksLikeDay: boolean;
};

export type DetectedCode = {
  code: string;
  count: number;
  /** What we would guess, for a person to accept or change. */
  guess: Meaning;
  /** False when the guess is little more than a shrug. */
  confident: boolean;
};

export type Analysis = {
  sheetName: string;
  sheetNames: string[];
  rowCount: number;
  columns: DetectedColumn[];
  dayColumns: string[];
  /** 'column_per_day' when dates run across the top, otherwise one row per day. */
  layout: 'column_per_day' | 'row_per_day';
  /** For column-per-day files that carry no year in the heading. */
  year: number | null;
  /** Split codes like "A|P" into two halves when a separator is common. */
  separator: string | null;
  fields: Partial<Record<PlatformField, string[]>>;
  codes: DetectedCode[];
};

/** Headings that are a date rather than a property: "1 / 8 | Sat", "01-Sep", "5". */
const DAY_HEADING = /^\s*(\d{1,2})\s*[/-]\s*(\d{1,2})|^\s*\d{1,2}\s*$|^\s*\d{1,2}[-/][A-Za-z]{3}/;

/** Heading patterns for each of our fields, best match first. */
const FIELD_HINTS: [PlatformField, RegExp[]][] = [
  ['employee_code', [/^emp(loyee)?\s*(id|code|no|number)/i, /\bcode\b/i, /\bid\b/i]],
  ['employee_name', [/^(full|employee|emp)\s*name/i, /^name$/i, /\bname\b/i]],
  ['mobile', [/mobile|whats ?app/i, /phone|contact|cell/i]],
  ['email', [/e-?mail/i]],
  ['department', [/depart|^dept/i]],
  ['branch', [/branch/i]],
  ['location', [/location|site|office/i]],
  ['designation', [/designation|title|role|grade/i]],
  ['shift_code', [/shift/i]],
  ['calendar_code', [/calendar|roster/i]],
  ['manager_ref', [/(manager|reporting|supervisor).*(id|code|emp)/i, /manager|reporting|supervisor/i]],
  ['manager_mobile', [/(manager|reporting|supervisor).*(mobile|phone|contact)/i]],
  ['date_of_joining', [/join/i, /\bdoj\b/i]],
  ['exit_date', [/exit|reliev|separat|last ?working/i]],
  ['language', [/language|lang/i]],
  // Before `employment_status`, because a bare "Status" column in an attendance
  // file is the attendance, and claiming it as employment leaves the file with
  // no codes at all.
  ['attendance_status', [/attendance|punch ?status/i, /^status$/i, /present/i]],
  ['employment_status', [/employment ?status|confirmation|probation/i]],
];

/** What a code most likely means, judged from the code itself. */
const CODE_HINTS: [RegExp, Meaning, boolean][] = [
  [/^(p|present|w|wd)$/i, 'present', true],
  [/^(a|ab|abs|absent)$/i, 'absent_full', true],
  [/^(hd|half ?day|0\.5)$/i, 'absent_half_unspecified', true],
  [/^(wo|w\/o|weekly ?off|off)$/i, 'weekly_off', true],
  [/^(h|ho|hol|holiday|ph)$/i, 'holiday', true],
  [/^(oh|optional)/i, 'optional_holiday', true],
  [/^(od|on ?duty)$/i, 'on_duty', true],
  [/^(wfh|home)$/i, 'work_from_home', true],
  [/^(co|comp ?off)$/i, 'comp_off', true],
  [/^(cl|sl|el|pl|leave|lv)$/i, 'leave_approved', true],
  [/^(lop|lwp|unpaid)$/i, 'leave_unpaid', true],
  [/^(mp|missed ?punch|mis ?punch)$/i, 'missed_punch', true],
  [/^(lt|late)$/i, 'late_in', true],
  [/^(eg|early)$/i, 'early_out', true],
  [/^(tr|training)$/i, 'training', true],
  [/^(tv|travel|tour)$/i, 'travel', true],
  [/^0$/, 'absent_full', false],
  [/^1$/, 'present', false],
];

function guessMeaning(code: string): { guess: Meaning; confident: boolean } {
  for (const [pattern, meaning, confident] of CODE_HINTS) {
    if (pattern.test(code.trim())) return { guess: meaning, confident };
  }
  return { guess: 'unknown', confident: false };
}

/** The separator in codes like "A|P" or "A/P", when most cells carry one. */
function detectSeparator(values: string[]): string | null {
  for (const candidate of ['|', '/', '-']) {
    const split = values.filter((v) => v.includes(candidate)).length;
    if (split >= Math.max(2, values.length * 0.4)) return candidate;
  }
  return null;
}

function guessFields(columns: string[]): Partial<Record<PlatformField, string[]>> {
  const taken = new Set<string>();
  const out: Partial<Record<PlatformField, string[]>> = {};

  // A name split over two columns has to be caught before the generic /name/
  // rule, which would otherwise claim "First Name" and stop there.
  const first = columns.find((c) => /first\s*name/i.test(c));
  const last = columns.find((c) => /last\s*name|surname/i.test(c));
  if (first && last) {
    out.employee_name = [first, last];
    taken.add(first);
    taken.add(last);
  }

  for (const [field, patterns] of FIELD_HINTS) {
    if (out[field]) continue;
    for (const pattern of patterns) {
      const hit = columns.find((c) => !taken.has(c) && pattern.test(c));
      if (hit) {
        out[field] = [hit];
        taken.add(hit);
        break;
      }
    }
  }

  return out;
}

export function analyseFile(buffer: Buffer | Uint8Array, sheetHint?: string | null): Analysis {
  const wb = readWorkbook(buffer);
  const table: SourceTable = pickTable(wb, sheetHint);

  const dayColumns = table.columns.filter((c) => DAY_HEADING.test(c));
  const layout = dayColumns.length >= 5 ? 'column_per_day' : 'row_per_day';

  const columns: DetectedColumn[] = table.columns.map((name) => ({
    name,
    samples: columnValues(table, name, 4).map((v) => v.value),
    looksLikeDay: dayColumns.includes(name),
  }));

  const fields = guessFields(table.columns.filter((c) => !dayColumns.includes(c)));

  // Codes come from the day columns when dates run across the top, and from the
  // status column when each row is one day.
  const codeCounts = new Map<string, number>();
  const sources = layout === 'column_per_day' ? dayColumns : (fields.attendance_status ?? []);
  for (const column of sources) {
    for (const { value, count } of columnValues(table, column, 200)) {
      codeCounts.set(value, (codeCounts.get(value) ?? 0) + count);
    }
  }

  const rawCodes = [...codeCounts.keys()];
  const separator = detectSeparator(rawCodes);

  // With a separator, "A|P" is two codes rather than one, and it is the halves
  // that need a meaning.
  const halves = new Map<string, number>();
  for (const [value, count] of codeCounts) {
    const parts = separator ? value.split(separator).map((p) => p.trim()) : [value];
    for (const part of parts) {
      if (!part) continue;
      halves.set(part, (halves.get(part) ?? 0) + count);
    }
  }

  const codes: DetectedCode[] = [...halves.entries()]
    .map(([code, count]) => ({ code, count, ...guessMeaning(code) }))
    .sort((a, b) => b.count - a.count);

  return {
    sheetName: table.sheetName,
    sheetNames: wb.tables.map((t) => t.sheetName),
    rowCount: table.rows.length,
    columns,
    dayColumns,
    layout,
    year: detectRunDate(wb)?.year ?? null,
    separator,
    fields,
    codes,
  };
}

/** Turns the analysis, as edited by a person, into the profile the importer reads. */
export function buildFieldMap(input: {
  sheetName: string;
  fields: Partial<Record<PlatformField, string[]>>;
  layout: 'column_per_day' | 'row_per_day';
  dateColumn?: string | null;
  headerPattern?: string | null;
  year?: number | null;
  separator?: string | null;
}): FieldMap {
  const fields: FieldMap['fields'] = {};
  for (const field of PLATFORM_FIELDS) {
    const columns = input.fields[field]?.filter(Boolean) ?? [];
    if (!columns.length) continue;
    fields[field] = {
      columns,
      ...(columns.length > 1 ? { join: ' ' } : {}),
      transform: field === 'mobile' ? ['phone_india'] : ['trim'],
    };
  }

  return {
    fields,
    dateLayout:
      input.layout === 'column_per_day'
        ? {
            kind: 'column_per_day',
            headerPattern: input.headerPattern || '^\\s*(\\d{1,2})\\s*[/-]\\s*(\\d{1,2})',
            yearFrom: input.year ? 'fixed' : 'filter_sheet',
            ...(input.year ? { year: input.year } : {}),
          }
        : { kind: 'row_per_day', column: input.dateColumn || 'Date' },
    statusLayout: input.separator ? { kind: 'two_session', separator: input.separator } : { kind: 'single' },
    sheetHint: input.sheetName,
  };
}

export const MEANING_OPTIONS = ALL_MEANINGS;
