import * as XLSX from 'xlsx';
import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Db } from '@/db';
import {
  attendanceDays,
  employees,
  payrollProfiles,
  payrollRows,
  payrollUploads,
  type PayrollFieldMap,
  type PayrollReport,
} from '@/db/schema';
import { readWorkbook, type SourceTable } from '@/lib/mapping/source';
import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { isLocked, monthLabel } from '@/lib/locks';

/**
 * Payroll: the salary register a customer uploads once a month, after that
 * month's attendance is locked, so the agent can answer salary questions from
 * the final attendance and the salary actually paid.
 *
 * Every payroll system names its columns its own way, so each customer has a
 * payroll mapping, set up on Mapping like the attendance one: which
 * heading is the employee code, days in the month, paid days, the monthly rate,
 * gross, deductions, net and arrears, and which headings are not kept. A sample
 * file can fill the form in (`detectFields`), and nothing counts until HR saves
 * it. Everything else is kept under its own heading for the agent to read, except
 * what must never be kept: PAN, Aadhaar, bank account and IFSC, and the like.
 */

export const PAYROLL_FIELDS = [
  { key: 'employeeCode', label: 'Employee code', required: true },
  { key: 'calendarDays', label: 'Days in the month', required: true },
  { key: 'paidDays', label: 'Paid days', required: true },
  { key: 'rate', label: 'Monthly salary (full rate)', required: false },
  { key: 'gross', label: 'Gross salary earned', required: true },
  { key: 'deductions', label: 'Total deductions', required: false },
  { key: 'net', label: 'Net pay (take home)', required: true },
  { key: 'arrears', label: 'Arrears', required: false },
] as const satisfies readonly { key: keyof PayrollFieldMap; label: string; required: boolean }[];

const norm = (heading: string) => heading.replace(/\s+/g, ' ').trim().toLowerCase();

/** How each key column is usually headed. The first heading that matches wins. */
const PATTERNS: Record<keyof PayrollFieldMap, RegExp[]> = {
  employeeCode: [/^(employee|emp\.?|staff)\s*(code|id|no\.?|number)$/, /^e\.?\s*code$/, /^code$/],
  calendarDays: [/^calendar days$/, /^(days in (the )?month|month days|total days|working days in month)$/],
  paidDays: [/^(paid|payable) days$/, /^days paid$/],
  rate: [/^monthly rate$/, /^(gross|monthly|fixed) (rate|salary rate|gross)$/, /^gross \(r\)$/, /^rate$/],
  gross: [/^gross salary$/, /^(earned|actual) gross$/, /^gross earnings?$/, /^total earnings?$/, /^gross$/],
  deductions: [/^(gross|total) deductions?$/, /^deductions?$/],
  net: [/^net take ?home$/, /^net (pay|salary|amount|payable)$/, /^take ?home$/],
  arrears: [/^gross arrears?$/, /^arrears?( amount)?$/],
};

/** Never stored, whatever HR chooses: identity and bank details. */
const SENSITIVE = /\bpan\b|aadh?aa?r|account (no|number)|a\/c|\bifsc\b|\bbank\b|\buan\b|(esic?|pf) (no|number)|passport/;
/** Not kept unless HR says so: internal cost, tax workings, processing stamps, row numbers. */
const NOT_KEPT_BY_DEFAULT = /employee cost|\bctc\b|addtax|processing date|release date|^serial|^s\.? ?no\.?$|hold status|pay mode/;

export const isSensitive = (heading: string) => SENSITIVE.test(norm(heading));

/** The key columns as far as the headings say. */
export function detectFields(columns: string[]): Partial<PayrollFieldMap> {
  const found: Partial<PayrollFieldMap> = {};
  for (const key of Object.keys(PATTERNS) as (keyof PayrollFieldMap)[]) {
    for (const pattern of PATTERNS[key]) {
      const hit = columns.find((column) => pattern.test(norm(column)) && !Object.values(found).includes(column));
      if (hit) {
        found[key] = hit;
        break;
      }
    }
  }
  return found;
}

/** Headings left out by default: the sensitive ones, and internal ones nobody asks about. */
export function defaultExcluded(columns: string[]): string[] {
  return columns.filter((column) => isSensitive(column) || NOT_KEPT_BY_DEFAULT.test(norm(column)));
}

export function missingRequired(map: Partial<PayrollFieldMap>): string[] {
  return PAYROLL_FIELDS.filter((field) => field.required && !map[field.key]).map((field) => field.label);
}

/** The sheet with the salary rows: the one that has an employee code column, widest first. */
export function payrollTable(buffer: Buffer | Uint8Array): SourceTable {
  const wb = readWorkbook(buffer);
  const tables = [...wb.tables].filter((t) => t.rows.length).sort((a, b) => b.columns.length - a.columns.length);
  const table = tables.find((t) => detectFields(t.columns.map((c) => c.trim())).employeeCode) ?? tables[0];
  if (!table) throw new Error('The file has no readable sheet.');
  // Headings come back as written, stray spaces and all (" Net take home"); they are kept trimmed.
  return {
    sheetName: table.sheetName,
    columns: table.columns.map((c) => c.trim()),
    rows: table.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim(), v]))),
  };
}

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim());
const number = (value: unknown): number | null => {
  const cleaned = text(value).replace(/[,₹\s]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The month a file says it is for, from salary month and year columns, if it
 * has them: YYYY-MM, or null when it does not say.
 */
export function monthInFile(table: SourceTable): string | null {
  const monthColumn = table.columns.find((c) => /^(salary|pay|payroll)?\s*month$/.test(norm(c)));
  const yearColumn = table.columns.find((c) => /^(salary|pay|payroll)?\s*year$/.test(norm(c)));
  if (!monthColumn || !yearColumn) return null;
  const first = table.rows.find((row) => number(row[monthColumn]) && number(row[yearColumn]));
  if (!first) return null;
  const m = number(first[monthColumn])!;
  const y = number(first[yearColumn])!;
  if (m < 1 || m > 12 || y < 2000) return null;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Days not paid, as a locked month's attendance shows them. A half day is half. */
const UNPAID: Partial<Record<Meaning, number>> = {
  absent_full: 1,
  absent_first_half: 0.5,
  absent_second_half: 0.5,
  absent_half_unspecified: 0.5,
  leave_unpaid: 1,
  leave_rejected: 1,
  suspension: 1,
  not_employed: 1,
};

function bounds(month: string): [string, string] {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
}

/**
 * Reads a payroll file into a month: one row per employee, matched by code,
 * key figures pulled out, everything not dropped kept by heading. Checked
 * against the month's locked attendance - the checks are warnings for HR, not
 * reasons to refuse it. The caller has already made sure the month is locked
 * and has no payroll yet.
 */
export async function importPayroll(
  tx: Db,
  tenantId: string,
  uploadId: string,
  month: string,
  table: SourceTable,
  map: PayrollFieldMap,
  excluded: string[],
): Promise<PayrollReport> {
  const dropped = [...new Set([...excluded, ...table.columns.filter(isSensitive)])];
  const kept = table.columns.filter((column) => !dropped.includes(column));

  const codes = table.rows.map((row) => text(row[map.employeeCode])).filter(Boolean);
  const people = codes.length
    ? await tx
        .select({ id: employees.id, code: employees.empCode, name: employees.fullName })
        .from(employees)
        .where(and(eq(employees.tenantId, tenantId), inArray(employees.empCode, codes)))
    : [];
  const byCode = new Map(people.map((p) => [p.code, p]));

  // What the locked attendance says each matched person was not paid for.
  const [from, to] = bounds(month);
  const days = people.length
    ? await tx
        .select({ employeeId: attendanceDays.employeeId, meaning: attendanceDays.meaning })
        .from(attendanceDays)
        .where(and(eq(attendanceDays.tenantId, tenantId), inArray(attendanceDays.employeeId, people.map((p) => p.id)), gte(attendanceDays.attDate, from), lt(attendanceDays.attDate, to)))
    : [];
  const unpaid = new Map<string, { unpaid: number; days: number }>();
  for (const day of days) {
    const tally = unpaid.get(day.employeeId) ?? { unpaid: 0, days: 0 };
    tally.unpaid += UNPAID[day.meaning as Meaning] ?? 0;
    tally.days++;
    unpaid.set(day.employeeId, tally);
  }

  const report: PayrollReport = { rows: 0, matched: 0, unmatched: [], warnings: [], dropped };
  const seen = new Set<string>();
  for (const row of table.rows) {
    const code = text(row[map.employeeCode]);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const person = byCode.get(code) ?? null;
    const figures = {
      calendarDays: number(row[map.calendarDays]),
      paidDays: number(row[map.paidDays]),
      monthlyRate: map.rate ? number(row[map.rate]) : null,
      gross: number(row[map.gross]),
      deductions: map.deductions ? number(row[map.deductions]) : null,
      net: number(row[map.net]),
      arrears: map.arrears ? number(row[map.arrears]) : null,
    };
    const nameColumn = table.columns.find((c) => /^(full |employee )?name$/.test(norm(c)));
    await tx.insert(payrollRows).values({
      tenantId,
      uploadId,
      month,
      employeeId: person?.id ?? null,
      empCode: code,
      employeeName: person?.name ?? (nameColumn ? text(row[nameColumn]) || null : null),
      ...figures,
      fields: kept.map((column) => [column, text(row[column])] as [string, string]),
    });
    report.rows++;
    if (!person) {
      report.unmatched.push(code);
      continue;
    }
    report.matched++;

    const warn = (message: string) => report.warnings.push({ empCode: code, name: person.name, text: message });
    const { calendarDays, paidDays, monthlyRate, gross } = figures;
    if (calendarDays !== null && paidDays !== null && paidDays > calendarDays) warn(`Paid days (${paidDays}) are more than the days in the month (${calendarDays}).`);
    if (monthlyRate && calendarDays && paidDays !== null && gross !== null) {
      const expected = (monthlyRate * paidDays) / calendarDays;
      if (Math.abs(expected - gross) > Math.max(2, expected * 0.005)) {
        warn(`Gross salary ${gross} is not the monthly rate for the paid days (${Math.round(expected)}).`);
      }
    }
    const tally = unpaid.get(person.id);
    if (tally && calendarDays !== null && paidDays !== null) {
      const expectedPaid = calendarDays - tally.unpaid;
      if (Math.abs(expectedPaid - paidDays) > 0.01) {
        warn(`Paid days are ${paidDays}, but the locked attendance shows ${tally.unpaid} unpaid ${tally.unpaid === 1 ? 'day' : 'days'} (${expectedPaid} paid).`);
      }
    } else if (!tally) {
      warn(`There is no attendance for ${monthLabel(month)} to check the paid days against.`);
    }
  }
  return report;
}

/** Whether a month can take a payroll upload now: locked, and none uploaded yet. Null when it can. */
export async function payrollRefusal(tx: Db, tenantId: string, month: string): Promise<string | null> {
  if (!(await isLocked(tx, tenantId, `${month}-01`))) return `${monthLabel(month)}'s attendance is not locked. Lock it first, then upload its payroll.`;
  const [already] = await tx
    .select({ id: payrollUploads.id })
    .from(payrollUploads)
    .where(and(eq(payrollUploads.tenantId, tenantId), eq(payrollUploads.month, month)))
    .limit(1);
  return already ? `${monthLabel(month)}'s payroll has already been uploaded. To replace it, unlock its payroll in the Months table first.` : null;
}

/**
 * Unlocks a month's payroll for a fresh upload: the upload and every row read
 * from it go, so the agent has no salary for that month until the right file is
 * in. The attendance lock stays. False when the month had no payroll.
 */
export async function removePayroll(tx: Db, tenantId: string, month: string): Promise<boolean> {
  const removed = await tx
    .delete(payrollUploads)
    .where(and(eq(payrollUploads.tenantId, tenantId), eq(payrollUploads.month, month)))
    .returning({ id: payrollUploads.id });
  return removed.length > 0;
}

export async function payrollProfile(tx: Db, tenantId: string) {
  return (await tx.query.payrollProfiles.findFirst({ where: eq(payrollProfiles.tenantId, tenantId) })) ?? null;
}

/**
 * The saved mapping against one file's headings, matched however they are
 * spaced or capitalised: the file's own heading for each mapped column, or the
 * ones the file does not have.
 */
export function resolveMap(map: PayrollFieldMap, columns: string[]): { map: PayrollFieldMap } | { missing: string[] } {
  const resolved: Partial<PayrollFieldMap> = {};
  const missing: string[] = [];
  for (const field of PAYROLL_FIELDS) {
    const heading = map[field.key];
    if (!heading) continue;
    const found = columns.find((column) => norm(column) === norm(heading));
    if (found) resolved[field.key] = found;
    else missing.push(`"${heading}" (${field.label.toLowerCase()})`);
  }
  return missing.length ? { missing } : { map: resolved as PayrollFieldMap };
}

/** The headings not kept, as this file writes them. */
export function resolveExcluded(excluded: string[], columns: string[]): string[] {
  const wanted = new Set(excluded.map(norm));
  return columns.filter((column) => wanted.has(norm(column)));
}

/* ------------------------------------------------------------------ *
 * What the agent reads
 * ------------------------------------------------------------------ */

const rupees = (value: number | null) => (value === null ? null : `₹${Math.round(value).toLocaleString('en-IN')}`);

/**
 * One employee's own payroll for the last six months uploaded, written out for
 * the model: the key figures in words, then every kept column as it is headed.
 * Empty when there is none.
 */
export async function payrollSummary(tx: Db, tenantId: string, employeeId: string): Promise<string> {
  const rows = await tx
    .select()
    .from(payrollRows)
    .where(and(eq(payrollRows.tenantId, tenantId), eq(payrollRows.employeeId, employeeId)))
    .orderBy(desc(payrollRows.month))
    .limit(6);
  if (!rows.length) return '';
  const lines = rows.map((row) => {
    const key = [
      row.calendarDays !== null ? `days in the month ${row.calendarDays}` : null,
      row.paidDays !== null ? `paid days ${row.paidDays}` : null,
      row.monthlyRate !== null ? `full monthly salary ${rupees(row.monthlyRate)}` : null,
      row.gross !== null ? `gross earned ${rupees(row.gross)}` : null,
      row.arrears ? `arrears ${rupees(row.arrears)}` : null,
      row.deductions !== null ? `deductions ${rupees(row.deductions)}` : null,
      row.net !== null ? `net pay ${rupees(row.net)}` : null,
    ].filter(Boolean);
    const all = row.fields.filter(([, value]) => value !== '').map(([heading, value]) => `${heading}: ${value}`);
    return `${monthLabel(row.month, new Date(0))}: ${key.join(', ')}.\n  Every column of their payroll row: ${all.join('; ')}`;
  });
  return [
    'Months listed are the ones whose payroll has been uploaded; any other month has none yet.',
    'In the payroll columns, "(R)" or "rate" means the full monthly rate, and the same name without it is what was paid for the month.',
    ...lines,
  ].join('\n');
}

/** What the agent is told about payroll, for its rules. */
export const PAYROLL_RULES = `SALARY: PAYROLL, when given, is this employee's own salary for the months listed, uploaded by their employer
after that month's attendance was made final. You may say those amounts. A month's pay is the full monthly salary times
the paid days, divided by the days in the month. The days not paid are the absences, unpaid leave and half days (a half
day counts half) in that month's ATTENDANCE: to explain a lower salary, give the days in the month, the paid days, and
the dates that were not paid. A deduction or an arrear you cannot explain from what is given: say what it is and raise
a ticket for why. A month with no payroll: say it has not been uploaded yet and raise a ticket if they need more.`;

/* ------------------------------------------------------------------ *
 * Downloads
 * ------------------------------------------------------------------ */

/** A month's locked attendance as a register: one row per employee, a column per day, and the totals. */
export async function attendanceWorkbook(tx: Db, tenantId: string, month: string): Promise<Buffer> {
  const [from, to] = bounds(month);
  const rows = await tx
    .select({
      code: employees.empCode,
      name: employees.fullName,
      department: employees.department,
      date: attendanceDays.attDate,
      raw: attendanceDays.rawStatus,
      meaning: attendanceDays.meaning,
    })
    .from(attendanceDays)
    .innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
    .where(and(eq(attendanceDays.tenantId, tenantId), gte(attendanceDays.attDate, from), lt(attendanceDays.attDate, to)))
    .orderBy(asc(employees.empCode), asc(attendanceDays.attDate));

  const [year, m] = month.split('-').map(Number) as [number, number];
  const dayCount = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const dates = Array.from({ length: dayCount }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const people = new Map<string, { code: string; name: string; department: string | null; days: Map<string, { raw: string | null; meaning: string }> }>();
  for (const row of rows) {
    const person = people.get(row.code) ?? { code: row.code, name: row.name, department: row.department, days: new Map() };
    person.days.set(row.date, { raw: row.raw, meaning: row.meaning });
    people.set(row.code, person);
  }
  const meanings = [...new Set(rows.map((r) => r.meaning))];
  const header = ['Employee code', 'Name', 'Department', ...dates.map((d) => String(Number(d.slice(8)))), ...meanings.map((m2) => MEANING_LABELS[m2 as Meaning] ?? m2), 'Unpaid days'];
  const body = [...people.values()].map((p) => {
    const counts = meanings.map((meaning) => [...p.days.values()].filter((d) => d.meaning === meaning).length);
    const unpaidDays = [...p.days.values()].reduce((total, d) => total + (UNPAID[d.meaning as Meaning] ?? 0), 0);
    return [p.code, p.name, p.department ?? '', ...dates.map((d) => p.days.get(d)?.raw ?? ''), ...counts, unpaidDays];
  });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, ...body]), `Attendance ${month}`);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** A month's payroll as uploaded, without the columns that were never kept. */
export async function payrollWorkbook(tx: Db, tenantId: string, month: string): Promise<Buffer | null> {
  const rows = await tx
    .select()
    .from(payrollRows)
    .where(and(eq(payrollRows.tenantId, tenantId), eq(payrollRows.month, month)))
    .orderBy(asc(payrollRows.empCode));
  if (!rows.length) return null;
  const header = rows[0]!.fields.map(([heading]) => heading);
  const body = rows.map((row) => row.fields.map(([, value]) => value));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, ...body]), `Payroll ${month}`);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
