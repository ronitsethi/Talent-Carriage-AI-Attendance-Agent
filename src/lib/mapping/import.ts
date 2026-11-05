import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import {
  attendanceDays,
  codeMappings,
  employees,
  employeeHistory,
  imports,
  mappingProfiles,
  tenantSettings,
  unmappedCodes,
  type ImportReport,
} from '@/db/schema';
import { applyProfile, type ApplyResult, type CodeLookup, type MappedEmployee, type MappedRecord } from './apply';
import { isNonWorking, type Meaning } from './meanings';
import { pickTable, readWorkbook, detectRunDate, type SourceWorkbook } from './source';
import { today as localToday } from '@/lib/dates';
import { lockedMonths, monthOf } from '@/lib/locks';

export type ImportOptions = {
  source: 'upload' | 'sftp' | 'blob' | 'api_pull' | 'db_read' | 'push' | 'seed';
  filename?: string;
  profileId?: string;
  createdBy?: string;
  /** Read and report, but change nothing. Used for onboarding sign-off. */
  dryRun?: boolean;
  /** The customer's today (YYYY-MM-DD), for tests; otherwise worked out from their timezone. */
  today?: string;
};

export type ImportResult = {
  importId: string | null;
  report: ImportReport;
  dateFrom?: string;
  dateTo?: string;
  dryRun: boolean;
};

/** The active profile and its code mappings for a tenant. */
export async function loadActiveProfile(tx: Db, tenantId: string, profileId?: string) {
  const profile = profileId
    ? await tx.query.mappingProfiles.findFirst({ where: eq(mappingProfiles.id, profileId) })
    : await tx.query.mappingProfiles.findFirst({
        where: and(eq(mappingProfiles.tenantId, tenantId), eq(mappingProfiles.status, 'active')),
      });
  if (!profile) throw new Error('No active mapping profile for this tenant');

  const rules = await tx.select().from(codeMappings).where(eq(codeMappings.profileId, profile.id));
  const codes: CodeLookup = new Map(
    rules.map((r) => [r.code.trim().toUpperCase(), { meaning: r.meaning as Meaning, chase: r.chase ?? null }]),
  );
  return { profile, codes };
}

/** Maps a file without touching the database, for previews and sign-off. */
export function mapWorkbook(
  wb: SourceWorkbook,
  fieldMap: Parameters<typeof applyProfile>[1],
  codes: CodeLookup,
): ApplyResult {
  const table = pickTable(wb, fieldMap.sheetHint ?? null);
  return applyProfile(table, fieldMap, codes, { runDate: detectRunDate(wb) });
}

/**
 * Reads an attendance file and brings it into the platform: employees upserted,
 * days written, unmapped codes recorded for an admin to resolve.
 *
 * Re-importing the same file is safe. Days are upserted by (employee, date), so
 * a corrected file overwrites the earlier value and bumps its revision — which
 * is how a later correction can close an open case.
 *
 * A deleted employee who appears in the file is brought back, along with any
 * cases that were kept when they were deleted: the attendance file is the
 * record of who works here, so somebody in it is an employee again, and their
 * unfinished cases go back to being work rather than a record.
 */
export async function importAttendanceFile(
  tx: Db,
  tenantId: string,
  buffer: Buffer | Uint8Array,
  opts: ImportOptions,
): Promise<ImportResult> {
  const wb = readWorkbook(buffer);
  const { profile, codes } = await loadActiveProfile(tx, tenantId, opts.profileId);
  const mapped: ApplyResult & { droppedMonths?: string[] } = mapWorkbook(wb, profile.fieldMap, codes);

  // Today is not over, so its attendance is not final: a file that runs up to
  // today is taken, but only up to yesterday. Today's column - and anything
  // later a register leaves blank - is never written.
  const settings = await tx.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, tenantId), columns: { timezone: true } });
  const cutoff = opts.today ?? localToday(settings?.timezone ?? 'Asia/Kolkata');
  const heldBack = holdBackFrom(mapped, cutoff);
  // A locked month's attendance is final: its days are skipped, and the rest of the file still imports.
  const locked = await lockedMonths(tx, tenantId);
  const lockedDays = locked.size ? dropDays(mapped, (date) => locked.has(monthOf(date))) : 0;

  const dates = mapped.records.flatMap((r) => r.days.map((d) => d.date)).sort();
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];

  const report: ImportReport = {
    rowsRead: mapped.records.length,
    employeesSeen: mapped.records.length,
    employeesCreated: 0,
    employeesUpdated: 0,
    employeesRestored: 0,
    daysImported: 0,
    ...(heldBack ? { daysHeldBack: heldBack } : {}),
    ...(lockedDays ? { daysLocked: lockedDays, lockedMonths: [...new Set(mapped.droppedMonths)].sort() } : {}),
    rejected: mapped.rejected,
    unmappedCodes: mapped.unmapped,
    meaningCounts: mapped.meaningCounts,
  };

  if (opts.dryRun) {
    return { importId: null, report, dateFrom, dateTo, dryRun: true };
  }

  const [importRow] = await tx
    .insert(imports)
    .values({
      tenantId,
      source: opts.source,
      profileId: profile.id,
      filename: opts.filename,
      dateFrom,
      dateTo,
      createdBy: opts.createdBy,
    })
    .returning();
  const importId = importRow!.id;

  try {
    const employeeIdByCode = new Map<string, string>();

    for (const record of mapped.records) {
      const { id, created, updatedFields, restored } = await upsertEmployee(tx, tenantId, record.employee, importId);
      employeeIdByCode.set(record.employee.empCode, id);
      if (created) report.employeesCreated++;
      else if (updatedFields) report.employeesUpdated++;
      if (restored) report.employeesRestored = (report.employeesRestored ?? 0) + 1;

      report.daysImported += await writeDays(tx, tenantId, id, record, importId);
    }

    await linkManagers(tx, tenantId, mapped.records, employeeIdByCode);
    await recordUnmappedCodes(tx, tenantId, mapped);

    const status = report.rejected.length || Object.keys(report.unmappedCodes).length ? 'partial' : 'completed';
    await tx.update(imports).set({ status, report, finishedAt: new Date() }).where(eq(imports.id, importId));
    return { importId, report, dateFrom, dateTo, dryRun: false };
  } catch (error) {
    // The transaction is already aborted, so recording the failure on the
    // import row here would itself fail - and that second failure is all the
    // caller would ever see. The real error is thrown for the caller to record
    // outside this transaction.
    throw error;
  }
}

/**
 * Drops every day on or after `cutoff` from the mapped file, in place, and takes
 * them out of the meaning counts too. Returns how many were dropped.
 */
export function holdBackFrom(mapped: ApplyResult, cutoff: string): number {
  return dropDays(mapped, (date) => date >= cutoff);
}

/**
 * Drops the days `drop` picks from the mapped file, in place, and takes them
 * out of the meaning counts too. Returns how many were dropped; the months they
 * fell in are noted on `droppedMonths`.
 */
export function dropDays(mapped: ApplyResult & { droppedMonths?: string[] }, drop: (date: string) => boolean): number {
  let dropped = 0;
  mapped.droppedMonths = [];
  for (const record of mapped.records) {
    const kept = record.days.filter((day) => !drop(day.date));
    for (const day of record.days) {
      if (!drop(day.date)) continue;
      dropped++;
      mapped.droppedMonths.push(day.date.slice(0, 7));
      const left = (mapped.meaningCounts[day.meaning] ?? 0) - 1;
      if (left > 0) mapped.meaningCounts[day.meaning] = left;
      else delete mapped.meaningCounts[day.meaning];
    }
    record.days = kept;
  }
  return dropped;
}

async function upsertEmployee(tx: Db, tenantId: string, emp: MappedEmployee, importId: string) {
  const existing = await tx.query.employees.findFirst({
    where: and(eq(employees.tenantId, tenantId), eq(employees.empCode, emp.empCode)),
  });

  const values = {
    tenantId,
    empCode: emp.empCode,
    fullName: emp.fullName,
    mobileRaw: emp.mobileRaw,
    mobileE164: emp.mobileE164,
    email: emp.email,
    department: emp.department,
    branch: emp.branch,
    location: emp.location,
    designation: emp.designation,
    shiftCode: emp.shiftCode,
    calendarCode: emp.calendarCode,
    managerRef: emp.managerRef,
    managerMobileE164: emp.managerMobileE164,
    dateOfJoining: emp.dateOfJoining,
    exitDate: emp.exitDate,
    employmentStatus: emp.employmentStatus,
    language: emp.language,
    sourceRow: emp.sourceRow,
  };

  if (!existing) {
    const [row] = await tx.insert(employees).values(values).returning();
    return { id: row!.id, created: true, updatedFields: 0, restored: false };
  }

  // They were deleted and the file has them again, so they work here again:
  // the deletion is lifted, which is also what makes the cases that were kept
  // when they went answerable once more.
  const restored = Boolean(existing.deletedAt);

  // A changed phone number is the one that can misdirect a message, so every
  // change is written to history with the import that caused it.
  const tracked: (keyof typeof values)[] = ['fullName', 'mobileE164', 'department', 'managerRef', 'exitDate'];
  const changes = tracked
    .filter((field) => (existing as Record<string, unknown>)[field] !== values[field])
    .map((field) => ({
      tenantId,
      employeeId: existing.id,
      field: String(field),
      oldValue: (existing as Record<string, unknown>)[field] == null ? null : String((existing as Record<string, unknown>)[field]),
      newValue: values[field] == null ? null : String(values[field]),
      source: importId,
    }));
  // Coming back is worth a line of its own: it explains why a frozen case
  // started moving again, and when.
  if (restored) {
    changes.push({
      tenantId,
      employeeId: existing.id,
      field: 'deletedAt',
      oldValue: existing.deletedAt!.toISOString(),
      newValue: null,
      source: importId,
    });
  }
  if (changes.length) await tx.insert(employeeHistory).values(changes);

  await tx
    .update(employees)
    .set({ ...values, deletedAt: null, updatedAt: new Date() })
    .where(eq(employees.id, existing.id));
  return { id: existing.id, created: false, updatedFields: changes.length, restored };
}

async function writeDays(tx: Db, tenantId: string, employeeId: string, record: MappedRecord, importId: string) {
  if (!record.days.length) return 0;

  const rows = record.days.map((day) => ({
    tenantId,
    employeeId,
    attDate: day.date,
    rawStatus: day.rawStatus,
    firstHalf: day.firstHalf,
    secondHalf: day.secondHalf,
    meaning: day.meaning,
    isWorkingDay: !isNonWorking(day.meaning),
    importId,
  }));

  // Chunked, because a monthly register for one employee is ~31 rows and a
  // single statement per employee keeps the import to one round trip each.
  await tx
    .insert(attendanceDays)
    .values(rows)
    .onConflictDoUpdate({
      target: [attendanceDays.tenantId, attendanceDays.employeeId, attendanceDays.attDate],
      set: {
        rawStatus: sql`excluded.raw_status`,
        firstHalf: sql`excluded.first_half`,
        secondHalf: sql`excluded.second_half`,
        meaning: sql`excluded.meaning`,
        isWorkingDay: sql`excluded.is_working_day`,
        importId: sql`excluded.import_id`,
        revision: sql`${attendanceDays.revision} + 1`,
        updatedAt: new Date(),
      },
    });

  return rows.length;
}

/**
 * Resolves "Reporting manager" text into a real employee, which is what makes
 * approvals possible. Matching is by employee code first, then by exact name.
 */
async function linkManagers(
  tx: Db,
  tenantId: string,
  records: MappedRecord[],
  employeeIdByCode: Map<string, string>,
) {
  const refs = [...new Set(records.map((r) => r.employee.managerRef).filter((r): r is string => Boolean(r)))];
  if (!refs.length) return;

  const byName = new Map<string, string>();
  const candidates = await tx
    .select({ id: employees.id, fullName: employees.fullName, empCode: employees.empCode })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), inArray(employees.fullName, refs)));
  for (const c of candidates) byName.set(c.fullName.toLowerCase(), c.id);

  for (const record of records) {
    const ref = record.employee.managerRef;
    const employeeId = employeeIdByCode.get(record.employee.empCode);
    if (!ref || !employeeId) continue;
    const managerId = employeeIdByCode.get(ref) ?? byName.get(ref.toLowerCase()) ?? null;
    if (managerId && managerId !== employeeId) {
      await tx.update(employees).set({ managerEmployeeId: managerId }).where(eq(employees.id, employeeId));
    }
  }
}

/** Unmapped codes are surfaced, never guessed — they can only ever mean `unknown`. */
async function recordUnmappedCodes(tx: Db, tenantId: string, mapped: ApplyResult) {
  const entries = Object.entries(mapped.unmapped);
  if (!entries.length) return;

  for (const [code, occurrences] of entries) {
    await tx
      .insert(unmappedCodes)
      .values({ tenantId, code, occurrences })
      .onConflictDoUpdate({
        target: [unmappedCodes.tenantId, unmappedCodes.code],
        set: {
          occurrences: sql`${unmappedCodes.occurrences} + ${occurrences}`,
          lastSeenAt: new Date(),
          resolvedAt: null,
        },
      });
  }
}
