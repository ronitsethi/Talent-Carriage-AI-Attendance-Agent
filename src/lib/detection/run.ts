import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { attendanceDays, cases, detectionRuns, employees } from '@/db/schema';
import { CHASED_BY_DEFAULT, OPTIONALLY_CHASED } from '@/db/schema/enums';
import { explainsAbsence, shouldChase, type Meaning } from '@/lib/mapping/meanings';
import { capAllows, outstandingCount, type EngineContext, type TenantSettings } from '@/lib/conversation/engine';
import { contactCase, contactCaseById } from '@/lib/contact';
import { buildContext, type FullContext } from '@/lib/runtime';

export type Gap = {
  preferredChannel: string;
  employeeId: string;
  empCode: string;
  fullName: string;
  mobileE164: string | null;
  department: string | null;
  managerEmployeeId: string | null;
  attDate: string;
  meaning: Meaning;
  rawStatus: string | null;
  existingCaseId: string | null;
  existingStatus: string | null;
};

export type SkipReason =
  | 'not_working_day'
  | 'manual_employee'
  | 'excluded_department'
  | 'excluded_employee'
  | 'new_joiner'
  | 'exited'
  | 'no_mobile'
  | 'opted_out';

/** The meanings this tenant chases, given the always-on set and its own choices. */
export function chasedMeanings(settings: TenantSettings): Meaning[] {
  const optional = (settings.chaseMeanings ?? []).filter((m) =>
    (OPTIONALLY_CHASED as readonly string[]).includes(m),
  ) as Meaning[];
  return [...(CHASED_BY_DEFAULT as readonly Meaning[]), ...optional];
}

/**
 * Everyone with a gap on one date, with any case they already have.
 *
 * Exclusions are applied here rather than later, so an excluded employee never
 * even appears as a case — which is what makes the counts on the dashboard the
 * same as the number of people who will be contacted.
 */
export async function findGaps(
  tx: Db,
  tenantId: string,
  date: string,
  settings: TenantSettings,
  opts?: { automaticOnly?: boolean },
): Promise<{ gaps: Gap[]; skipped: Record<string, number> }> {
  const meanings = chasedMeanings(settings);
  const rows = await tx
    .select({
      employeeId: employees.id,
      empCode: employees.empCode,
      fullName: employees.fullName,
      mobileE164: employees.mobileE164,
      department: employees.department,
      managerEmployeeId: employees.managerEmployeeId,
      dateOfJoining: employees.dateOfJoining,
      exitDate: employees.exitDate,
      optOut: employees.whatsappOptOut,
      operatingMode: employees.operatingMode,
      preferredChannel: employees.preferredChannel,
      attDate: attendanceDays.attDate,
      meaning: attendanceDays.meaning,
      rawStatus: attendanceDays.rawStatus,
      isWorkingDay: attendanceDays.isWorkingDay,
      existingCaseId: cases.id,
      existingStatus: cases.status,
    })
    .from(attendanceDays)
    .innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
    .leftJoin(cases, and(eq(cases.employeeId, employees.id), eq(cases.attDate, attendanceDays.attDate)))
    .where(
      and(
        eq(attendanceDays.tenantId, tenantId),
        eq(attendanceDays.attDate, date),
        inArray(attendanceDays.meaning, meanings),
      ),
    )
    .orderBy(asc(employees.fullName));

  const skipped: Record<string, number> = {};
  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const excludedDepartments = new Set((settings.excludedDepartments ?? []).map((d) => d.toLowerCase()));
  const excludedCodes = new Set(settings.excludedEmployeeCodes ?? []);
  const gaps: Gap[] = [];

  for (const row of rows) {
    if (!row.isWorkingDay) {
      skip('not_working_day');
      continue;
    }
    // An employee set to manual is only ever contacted when HR runs a check.
    if (opts?.automaticOnly && (row.operatingMode ?? settings.operatingMode) !== 'automatic') {
      skip('manual_employee');
      continue;
    }
    if (!shouldChase(row.meaning as Meaning, { tenantChaseMeanings: settings.chaseMeanings ?? [] })) {
      continue;
    }
    if (excludedCodes.has(row.empCode)) {
      skip('excluded_employee');
      continue;
    }
    if (row.department && excludedDepartments.has(row.department.toLowerCase())) {
      skip('excluded_department');
      continue;
    }
    if (settings.excludeExitedEmployees && row.exitDate && row.exitDate < date) {
      skip('exited');
      continue;
    }
    if (settings.excludeFirstDays > 0 && row.dateOfJoining) {
      const joined = new Date(`${row.dateOfJoining}T00:00:00Z`).getTime();
      const on = new Date(`${date}T00:00:00Z`).getTime();
      if ((on - joined) / 86_400_000 < settings.excludeFirstDays) {
        skip('new_joiner');
        continue;
      }
    }
    if (!row.mobileE164) skip('no_mobile');
    if (row.optOut) skip('opted_out');

    gaps.push({
      preferredChannel: row.preferredChannel,
      employeeId: row.employeeId,
      empCode: row.empCode,
      fullName: row.fullName,
      mobileE164: row.mobileE164,
      department: row.department,
      managerEmployeeId: row.managerEmployeeId,
      attDate: row.attDate,
      meaning: row.meaning as Meaning,
      rawStatus: row.rawStatus,
      existingCaseId: row.existingCaseId,
      existingStatus: row.existingStatus,
    });
  }

  return { gaps, skipped };
}

export type DailyCheckOptions = {
  date: string;
  trigger: 'schedule' | 'manual' | 'import' | 'catch_up';
  /** Find and report, create nothing, send nothing. */
  dryRun?: boolean;
  /** Create cases but send no messages - used to build a backlog safely. */
  createOnly?: boolean;
  /**
   * Create the cases, but list who should be contacted instead of contacting
   * them. See `runDailyCheckAndContact` for why that is not the same thing as
   * doing it here.
   */
  deferContact?: boolean;
  importId?: string;
};

export type DailyCheckResult = {
  runId: string | null;
  date: string;
  gapsFound: number;
  casesCreated: number;
  casesQueued: number;
  messagesSent: number;
  alreadyOpen: number;
  blocked: { employee: string; reason: string }[];
  skipped: Record<string, number>;
  /** Only with `deferContact`: the cases this run decided are ready to ask. */
  toContact: { caseId: string; employeeId: string; fullName: string }[];
};

/**
 * The daily check.
 *
 * One case per employee per date, created once and never duplicated. Whether it
 * is asked immediately depends only on the outstanding-question cap: at the
 * default of 0 every gap is asked as it is found, so a long absence becomes a
 * chain of dated questions that simply wait for the employee.
 */
/**
 * The date an automatic run should look at.
 *
 * Contact happens the day after the absence: attendance for a day is not final
 * until the day has ended, so a run on the 22nd chases the 21st.
 */
export function contactDateFor(settings: TenantSettings, at = new Date()): string {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timezone }).format(at);
  const day = new Date(`${local}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - settings.contactLagDays);
  return day.toISOString().slice(0, 10);
}

export async function runDailyCheck(ctx: FullContext, opts: DailyCheckOptions): Promise<DailyCheckResult> {
  const { gaps, skipped } = await findGaps(ctx.tx, ctx.tenantId, opts.date, ctx.settings, {
    automaticOnly: opts.trigger === 'schedule',
  });

  const result: DailyCheckResult = {
    runId: null,
    date: opts.date,
    gapsFound: gaps.length,
    casesCreated: 0,
    casesQueued: 0,
    messagesSent: 0,
    alreadyOpen: gaps.filter((g) => g.existingCaseId).length,
    blocked: [],
    skipped,
    toContact: [],
  };

  if (opts.dryRun) return result;

  const [run] = await ctx.tx
    .insert(detectionRuns)
    .values({
      tenantId: ctx.tenantId,
      runFor: opts.date,
      trigger: opts.trigger,
      dryRun: false,
      gapsFound: gaps.length,
    })
    .returning();
  result.runId = run!.id;

  for (const gap of gaps) {
    if (gap.existingCaseId) continue;

    // ON CONFLICT is the real guarantee: two runs at once still create one case.
    const inserted = await ctx.tx
      .insert(cases)
      .values({
        tenantId: ctx.tenantId,
        employeeId: gap.employeeId,
        attDate: gap.attDate,
        meaning: gap.meaning,
        rawStatus: gap.rawStatus,
        status: 'queued',
        detectedByImportId: opts.importId,
      })
      .onConflictDoNothing({ target: [cases.tenantId, cases.employeeId, cases.attDate] })
      .returning();
    if (!inserted.length) continue;

    result.casesCreated++;
    const caseRow = inserted[0]!;

    if (opts.createOnly) {
      result.casesQueued++;
      continue;
    }

    const outstanding = await outstandingCount(ctx, gap.employeeId);
    if (!capAllows(ctx.settings, outstanding)) {
      // Held back deliberately; it is asked as soon as an earlier date is answered.
      result.casesQueued++;
      continue;
    }

    const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, gap.employeeId) });
    if (!employee) continue;

    if (opts.deferContact) {
      result.toContact.push({ caseId: caseRow.id, employeeId: employee.id, fullName: gap.fullName });
      continue;
    }

    const contacted = await contactCase(ctx, caseRow, employee);
    if (contacted.contacted) result.messagesSent++;
    else {
      result.casesQueued++;
      result.blocked.push({ employee: gap.fullName, reason: contacted.reason });
    }
  }

  await ctx.tx
    .update(detectionRuns)
    .set({
      casesCreated: result.casesCreated,
      casesQueued: result.casesQueued,
      messagesSent: result.messagesSent,
      skipped,
      finishedAt: new Date(),
    })
    .where(eq(detectionRuns.id, run!.id));

  return result;
}

/**
 * The case for one employee and date, created from the attendance record if it
 * does not exist yet. Used when HR contacts someone straight from the dashboard,
 * before any check has run.
 */
export async function ensureCase(tx: Db, tenantId: string, employeeId: string, date: string) {
  const existing = await tx.query.cases.findFirst({
    where: and(eq(cases.tenantId, tenantId), eq(cases.employeeId, employeeId), eq(cases.attDate, date)),
  });
  if (existing) return existing;

  const day = await tx.query.attendanceDays.findFirst({
    where: and(
      eq(attendanceDays.tenantId, tenantId),
      eq(attendanceDays.employeeId, employeeId),
      eq(attendanceDays.attDate, date),
    ),
  });
  if (!day) return null;

  const inserted = await tx
    .insert(cases)
    .values({
      tenantId,
      employeeId,
      attDate: date,
      meaning: day.meaning,
      rawStatus: day.rawStatus,
      status: 'queued',
    })
    .onConflictDoNothing({ target: [cases.tenantId, cases.employeeId, cases.attDate] })
    .returning();

  return (
    inserted[0] ??
    (await tx.query.cases.findFirst({
      where: and(eq(cases.tenantId, tenantId), eq(cases.employeeId, employeeId), eq(cases.attDate, date)),
    })) ??
    null
  );
}

/**
 * Closes cases that later data explains by itself.
 *
 * If a corrected register shows the day as approved leave, or the employee
 * applied it in the HRMS meanwhile, the case is resolved quietly rather than
 * being chased again — which is what stops the agent nagging about something
 * already sorted.
 */
export async function closeCasesExplainedByData(tx: Db, tenantId: string, date?: string) {
  const open = await tx
    .select({
      caseId: cases.id,
      attDate: cases.attDate,
      status: cases.status,
      meaning: attendanceDays.meaning,
    })
    .from(cases)
    .innerJoin(
      attendanceDays,
      and(eq(attendanceDays.employeeId, cases.employeeId), eq(attendanceDays.attDate, cases.attDate)),
    )
    .where(
      and(
        eq(cases.tenantId, tenantId),
        inArray(cases.status, ['queued', 'asked', 'delivered', 'read', 'answered', 'needs_hr']),
        date ? eq(cases.attDate, date) : sql`true`,
      ),
    );

  const toClose = open.filter((row) => explainsAbsence(row.meaning as Meaning));
  for (const row of toClose) {
    await tx
      .update(cases)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        closedByRevision: true,
        closeReason: `Attendance now shows ${row.meaning.replace(/_/g, ' ')}`,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, row.caseId));
  }
  return { closed: toClose.length };
}


/**
 * The daily check as the platform actually runs it: find everyone first, then
 * ring them.
 *
 * Detection and contact are deliberately not one transaction. Placing a call
 * tells LiveKit - another system, on another connection - about a call whose row
 * is still an uncommitted draft here. Inside one long transaction the first
 * person's phone starts ringing while their call record will not exist for
 * anyone else until the last person has been processed, and the agent that
 * answers for them is told there is no such call. It says nothing, and somebody
 * answers their phone to silence.
 *
 * So the cases are created and committed, and only then is each person
 * contacted, each in a transaction of their own that lasts milliseconds. One
 * person's failure is also now their own rather than the whole run's.
 */
export async function runDailyCheckAndContact(
  tenantId: string,
  opts: DailyCheckOptions,
): Promise<DailyCheckResult> {
  const result = await withTenant(tenantId, async (tx) =>
    runDailyCheck(await buildContext(tx, tenantId), { ...opts, deferContact: true }),
  );

  if (opts.dryRun || opts.createOnly) return result;

  for (const target of result.toContact) {
    try {
      const contacted = await withTenant(tenantId, async (tx) =>
        contactCaseById(await buildContext(tx, tenantId), target.caseId),
      );
      if (contacted?.contacted) result.messagesSent++;
      else {
        result.casesQueued++;
        result.blocked.push({
          employee: target.fullName,
          reason: contacted?.contacted === false ? contacted.reason : 'Could not be contacted',
        });
      }
    } catch (error) {
      result.casesQueued++;
      result.blocked.push({ employee: target.fullName, reason: (error as Error).message });
    }
  }

  // The run row was written in the first transaction, before any of this was
  // known, so the counts it carries are brought up to date here.
  await withTenant(tenantId, async (tx) => {
    if (!result.runId) return;
    await tx
      .update(detectionRuns)
      .set({ casesQueued: result.casesQueued, messagesSent: result.messagesSent })
      .where(eq(detectionRuns.id, result.runId));
  });

  return result;
}
