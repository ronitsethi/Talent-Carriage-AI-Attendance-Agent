import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { employees, leaveBalanceProfiles, leaveBalances, unmappedCodes, type LeaveFieldMap, type LeaveReport } from '@/db/schema';
import { codeMeaning, isUntypedLeave, leaveTypeName, loadCodeBook } from '@/lib/leave-types';
import { readWorkbook, type SourceTable } from '@/lib/mapping/source';

/**
 * Leave balances: a customer's file of how much leave each employee has left,
 * uploaded as often as they like, so the agent can answer "how many leaves do I
 * have?" from it next to the attendance.
 *
 * Each customer has a leave balance mapping, set up on Mapping like attendance
 * and payroll: which heading is the employee code, the leave type, the balance
 * and, if the file has them, the leave's full name, what is pending approval and
 * the balance once it is approved. A sample file can fill the form in
 * (`detectLeaveFields`); nothing counts until HR saves it.
 *
 * An upload is the balance as it stands: everyone in the file has their
 * balances replaced by the file's. Nobody else's change.
 *
 * Which leave each type is comes from the attendance code table on Mapping, the
 * one place codes are explained: PL there as Earned / privilege leave is PL here
 * too. A leave type that is not in it is listed with the codes nobody has
 * explained, and still kept under its code meanwhile.
 */

export const LEAVE_FIELDS = [
  { key: 'employeeCode', label: 'Employee code', required: true },
  { key: 'leaveType', label: 'Leave type (code)', required: true },
  { key: 'balance', label: 'Leave balance', required: true },
  { key: 'leaveName', label: 'Leave name', required: false },
  { key: 'pending', label: 'Pending leave (applied, not yet approved)', required: false },
  { key: 'balanceAfterPending', label: 'Balance once pending leave is approved', required: false },
] as const satisfies readonly { key: keyof LeaveFieldMap; label: string; required: boolean }[];

const norm = (heading: string) => heading.replace(/\s+/g, ' ').trim().toLowerCase();

/** How each column is usually headed. The first heading that matches wins. */
const PATTERNS: Record<keyof LeaveFieldMap, RegExp[]> = {
  employeeCode: [/^(employee|emp\.?|staff)\s*(code|id|no\.?|number)$/, /^e\.?\s*code$/, /^code$/],
  leaveType: [/^leave (type|code)$/, /^type$/],
  balanceAfterPending: [/balance.*(after|considering|net of|less|minus).*pending/, /^(net|projected) balance$/],
  balance: [/^leave balance$/, /^(closing|available|current) (leave )?balance$/, /^balance( days)?$/],
  leaveName: [/^leave name$/, /^leave (description|title)$/, /^leave$/],
  pending: [/^pending leaves?$/, /^pending( days)?$/, /^leaves? pending( approval)?$/, /^pending approval$/],
};

/** The columns as far as the headings say. */
export function detectLeaveFields(columns: string[]): Partial<LeaveFieldMap> {
  const found: Partial<LeaveFieldMap> = {};
  for (const key of Object.keys(PATTERNS) as (keyof LeaveFieldMap)[]) {
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

export function missingLeaveFields(map: Partial<LeaveFieldMap>): string[] {
  return LEAVE_FIELDS.filter((field) => field.required && !map[field.key]).map((field) => field.label);
}

/** The sheet with the balances: the one that has an employee code column, widest first. */
export function leaveTable(buffer: Buffer | Uint8Array): SourceTable {
  const wb = readWorkbook(buffer);
  const tables = [...wb.tables].filter((t) => t.rows.length).sort((a, b) => b.columns.length - a.columns.length);
  const table = tables.find((t) => detectLeaveFields(t.columns.map((c) => c.trim())).employeeCode) ?? tables[0];
  if (!table) throw new Error('The file has no readable sheet.');
  return {
    sheetName: table.sheetName,
    columns: table.columns.map((c) => c.trim()),
    rows: table.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim(), v]))),
  };
}

/** The saved mapping against one file's headings, however they are spaced or capitalised. */
export function resolveLeaveMap(map: LeaveFieldMap, columns: string[]): { map: LeaveFieldMap } | { missing: string[] } {
  const resolved: Partial<LeaveFieldMap> = {};
  const missing: string[] = [];
  for (const field of LEAVE_FIELDS) {
    const heading = map[field.key];
    if (!heading) continue;
    const found = columns.find((column) => norm(column) === norm(heading));
    if (found) resolved[field.key] = found;
    else missing.push(`"${heading}" (${field.label.toLowerCase()})`);
  }
  return missing.length ? { missing } : { map: resolved as LeaveFieldMap };
}

export async function leaveProfile(tx: Db, tenantId: string) {
  return (await tx.query.leaveBalanceProfiles.findFirst({ where: eq(leaveBalanceProfiles.tenantId, tenantId) })) ?? null;
}

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim());
const number = (value: unknown): number | null => {
  const cleaned = text(value).replace(/[,\s]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Reads a leave balance file: one row per employee per leave type, matched by
 * code. Everyone matched has their balances replaced by the file's, so a leave
 * type the file no longer lists for them goes too.
 */
export async function importLeaveBalances(
  tx: Db,
  tenantId: string,
  uploadId: string,
  table: SourceTable,
  map: LeaveFieldMap,
): Promise<LeaveReport> {
  const codes = [...new Set(table.rows.map((row) => text(row[map.employeeCode])).filter(Boolean))];
  const people = codes.length
    ? await tx
        .select({ id: employees.id, code: employees.empCode })
        .from(employees)
        .where(and(eq(employees.tenantId, tenantId), inArray(employees.empCode, codes)))
    : [];
  const byCode = new Map(people.map((p) => [p.code, p.id]));

  const report: LeaveReport = { rows: 0, employees: 0, balances: 0, unmatched: [], skipped: 0, leaveTypes: [] };
  // Per employee, per leave type: a type listed twice for someone keeps the last row.
  const balances = new Map<string, Map<string, typeof leaveBalances.$inferInsert>>();
  const unmatched = new Set<string>();
  const types = new Set<string>();
  for (const row of table.rows) {
    const code = text(row[map.employeeCode]);
    if (!code) continue;
    report.rows++;
    const employeeId = byCode.get(code);
    if (!employeeId) {
      unmatched.add(code);
      continue;
    }
    const leaveType = text(row[map.leaveType]);
    const balance = number(row[map.balance]);
    if (!leaveType || balance === null) {
      report.skipped++;
      continue;
    }
    types.add(leaveType);
    const mine = balances.get(employeeId) ?? new Map();
    mine.set(leaveType, {
      tenantId,
      employeeId,
      leaveType,
      leaveName: map.leaveName ? text(row[map.leaveName]) || null : null,
      balanceDays: balance,
      pendingDays: map.pending ? number(row[map.pending]) : null,
      balanceAfterPending: map.balanceAfterPending ? number(row[map.balanceAfterPending]) : null,
      source: 'upload',
      uploadId,
      asOf: new Date(),
    });
    balances.set(employeeId, mine);
  }

  const ids = [...balances.keys()];
  if (ids.length) {
    await tx.delete(leaveBalances).where(and(eq(leaveBalances.tenantId, tenantId), inArray(leaveBalances.employeeId, ids)));
    const rows = [...balances.values()].flatMap((mine) => [...mine.values()]);
    for (let i = 0; i < rows.length; i += 500) await tx.insert(leaveBalances).values(rows.slice(i, i + 500));
    report.balances = rows.length;
  }
  report.employees = ids.length;
  report.unmatched = [...unmatched];
  report.leaveTypes = [...types].sort();

  // Leave types the code table does not explain go where unexplained attendance
  // codes go, to be given a meaning once on Mapping.
  const book = await loadCodeBook(tx, tenantId);
  report.unexplained = report.leaveTypes.filter((code) => !codeMeaning(book, code));
  report.untyped = report.leaveTypes.filter((code) => isUntypedLeave(codeMeaning(book, code)));
  for (const code of report.unexplained) {
    const occurrences = [...balances.values()].filter((mine) => mine.has(code)).length || 1;
    await tx
      .insert(unmappedCodes)
      .values({ tenantId, code: code.toUpperCase(), occurrences })
      .onConflictDoUpdate({
        target: [unmappedCodes.tenantId, unmappedCodes.code],
        set: { occurrences: sql`${unmappedCodes.occurrences} + ${occurrences}`, lastSeenAt: new Date(), resolvedAt: null },
      });
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * What the agent reads
 * ------------------------------------------------------------------ */

/** A date as said aloud, in India's time: 9 November 2026. */
const onDate = (at: Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(at);

const days = (value: number) => `${value} ${value === 1 ? 'day' : 'days'}`;

/**
 * One employee's own leave balance, written out for the model: each leave type
 * with what is left, what is pending and what is left once it is approved, and
 * the date the balance is from. Empty when there is none.
 */
export async function leaveBalanceSummary(tx: Db, tenantId: string, employeeId: string): Promise<string> {
  const rows = await tx
    .select()
    .from(leaveBalances)
    .where(and(eq(leaveBalances.tenantId, tenantId), eq(leaveBalances.employeeId, employeeId)))
    .orderBy(desc(leaveBalances.asOf), asc(leaveBalances.leaveType));
  if (!rows.length) return '';
  const asOf = rows[0]!.asOf;
  const book = await loadCodeBook(tx, tenantId);
  const lines = rows.map((row) => {
    const name = leaveTypeName(book, row.leaveType, row.leaveName);
    const pending = row.pendingDays ? `; ${days(row.pendingDays)} applied and pending approval` : '';
    const after = row.balanceAfterPending !== null && row.pendingDays ? `, leaving ${days(row.balanceAfterPending)} once approved` : '';
    return `  ${name}: ${days(row.balanceDays)} left${pending}${after}.`;
  });
  return [`Leave balance as on ${onDate(asOf)}, by leave type:`, ...lines].join('\n');
}

/** What the agent is told about leave balances, for its rules. */
export const LEAVE_RULES = `LEAVE: LEAVE BALANCE, when given, is this employee's own leave left per leave type, from their employer, as on the
date shown. You may say it. Where leave is pending approval, give the balance and what is left once it is approved.
A leave type is named by its kind and code, e.g. "Sick leave (SL)"; ATTENDANCE gives the leave taken under the same
names and codes, so for leave taken of a type use that, and set it against the balance of the same type. Leave applied
or taken after the balance's date may not be in the balance yet, so say the date it is from. A leave type not listed, or no LEAVE BALANCE at all: say you do not have that balance
and raise a ticket if they need it. Never work a balance out yourself from the policy.`;
