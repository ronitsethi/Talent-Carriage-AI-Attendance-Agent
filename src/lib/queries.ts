import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { withPlatformScope, withTenant, type Db } from '@/db';
import { chasedMeanings } from '@/lib/detection/run';
import {
  actions,
  approvals,
  attendanceDays,
  calls,
  cases,
  codeMappings,
  conversations,
  employees,
  imports,
  mappingProfiles,
  messages,
  tenants,
  tenantSettings,
  unmappedCodes,
} from '@/db/schema';

/** Read helpers for the portal. Everything tenant-scoped runs inside withTenant. */

export type CaseListItem = {
  id: string;
  employeeId: string;
  channel: string;
  preferredChannel: string;
  operatingMode: string | null;
  attDate: string;
  meaning: string;
  rawStatus: string | null;
  status: string;
  replyOption: number | null;
  replyText: string | null;
  aiUsed: boolean;
  needsHrReason: string | null;
  error: string | null;
  askedAt: Date | null;
  answeredAt: Date | null;
  employeeName: string;
  employeeCode: string;
  department: string | null;
  mobile: string | null;
};

export async function listCases(
  tenantId: string,
  filters: { date?: string; from?: string; to?: string; status?: string; search?: string; limit?: number } = {},
): Promise<CaseListItem[]> {
  return withTenant(tenantId, async (tx) => {
    const conditions = [eq(cases.tenantId, tenantId)];
    // A single date is just a range of one, so callers can pass either.
    const from = filters.from ?? filters.date;
    const to = filters.to ?? filters.date;
    if (from) conditions.push(gte(cases.attDate, from));
    if (to) conditions.push(lte(cases.attDate, to));
    if (filters.status === 'open') {
      conditions.push(inArray(cases.status, ['queued', 'asked', 'delivered', 'read', 'answered', 'awaiting_action', 'awaiting_approval']));
    } else if (filters.status === 'attention') {
      conditions.push(inArray(cases.status, ['needs_hr', 'failed']));
    } else if (filters.status && filters.status !== 'all') {
      conditions.push(eq(cases.status, filters.status as 'asked'));
    }
    if (filters.search) {
      conditions.push(sql`(${employees.fullName} ilike ${`%${filters.search}%`} or ${employees.empCode} ilike ${`%${filters.search}%`})`);
    }

    return tx
      .select({
        id: cases.id,
        employeeId: cases.employeeId,
        channel: cases.channel,
        preferredChannel: employees.preferredChannel,
        operatingMode: employees.operatingMode,
        attDate: cases.attDate,
        meaning: cases.meaning,
        rawStatus: cases.rawStatus,
        status: cases.status,
        replyOption: cases.replyOption,
        replyText: cases.replyText,
        aiUsed: cases.aiUsed,
        needsHrReason: cases.needsHrReason,
        error: cases.error,
        askedAt: cases.askedAt,
        answeredAt: cases.answeredAt,
        employeeName: employees.fullName,
        employeeCode: employees.empCode,
        department: employees.department,
        mobile: employees.mobileE164,
      })
      .from(cases)
      .innerJoin(employees, eq(employees.id, cases.employeeId))
      .where(and(...conditions))
      .orderBy(desc(cases.attDate), asc(employees.fullName))
      .limit(filters.limit ?? 200);
  });
}

export type DashboardStats = {
  total: number;
  awaitingReply: number;
  answered: number;
  resolved: number;
  needsAttention: number;
  queued: number;
  byOption: Record<number, number>;
  employees: number;
  dataFrom: string | null;
  dataTo: string | null;
  lastImport: { at: Date; filename: string | null; rows: number } | null;
  openActions: number;
  pendingApprovals: number;
};

export async function dashboardStats(tenantId: string): Promise<DashboardStats> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ status: cases.status, replyOption: cases.replyOption, total: count() })
      .from(cases)
      .where(eq(cases.tenantId, tenantId))
      .groupBy(cases.status, cases.replyOption);

    const stats: DashboardStats = {
      total: 0,
      awaitingReply: 0,
      answered: 0,
      resolved: 0,
      needsAttention: 0,
      queued: 0,
      byOption: { 1: 0, 2: 0, 3: 0, 4: 0 },
      employees: 0,
      dataFrom: null,
      dataTo: null,
      lastImport: null,
      openActions: 0,
      pendingApprovals: 0,
    };

    for (const row of rows) {
      stats.total += row.total;
      if (['asked', 'delivered', 'read'].includes(row.status)) stats.awaitingReply += row.total;
      if (row.status === 'queued') stats.queued += row.total;
      if (['answered', 'awaiting_action', 'awaiting_approval'].includes(row.status)) stats.answered += row.total;
      if (row.status === 'resolved') stats.resolved += row.total;
      if (['needs_hr', 'failed'].includes(row.status)) stats.needsAttention += row.total;
      if (row.replyOption) stats.byOption[row.replyOption] = (stats.byOption[row.replyOption] ?? 0) + row.total;
    }

    const [people] = await tx.select({ total: count() }).from(employees).where(eq(employees.tenantId, tenantId));
    stats.employees = people?.total ?? 0;

    const [range] = await tx
      .select({ from: sql<string | null>`min(${attendanceDays.attDate})`, to: sql<string | null>`max(${attendanceDays.attDate})` })
      .from(attendanceDays)
      .where(eq(attendanceDays.tenantId, tenantId));
    stats.dataFrom = range?.from ?? null;
    stats.dataTo = range?.to ?? null;

    const lastImport = await tx.query.imports.findFirst({
      where: eq(imports.tenantId, tenantId),
      orderBy: desc(imports.startedAt),
    });
    if (lastImport) {
      stats.lastImport = {
        at: lastImport.startedAt,
        filename: lastImport.filename,
        rows: lastImport.report?.daysImported ?? 0,
      };
    }

    const [openActions] = await tx
      .select({ total: count() })
      .from(actions)
      .where(and(eq(actions.tenantId, tenantId), inArray(actions.status, ['awaiting_approval', 'executing', 'unconfirmed'])));
    stats.openActions = openActions?.total ?? 0;

    const [pending] = await tx
      .select({ total: count() })
      .from(approvals)
      .where(and(eq(approvals.tenantId, tenantId), eq(approvals.decision, 'pending')));
    stats.pendingApprovals = pending?.total ?? 0;

    return stats;
  });
}

export async function caseDetail(tenantId: string, caseId: string) {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        caseRow: cases,
        employee: employees,
      })
      .from(cases)
      .innerJoin(employees, eq(employees.id, cases.employeeId))
      .where(and(eq(cases.tenantId, tenantId), eq(cases.id, caseId)));
    if (!row) return null;

    const transcript = await tx
      .select()
      .from(messages)
      .where(eq(messages.conversationId, sql`(select id from conversations where employee_id = ${row.employee.id} limit 1)`))
      .orderBy(asc(messages.createdAt))
      .limit(200);

    const caseActions = await tx.select().from(actions).where(eq(actions.caseId, caseId)).orderBy(desc(actions.createdAt));
    const caseApprovals = caseActions.length
      ? await tx
          .select()
          .from(approvals)
          .where(inArray(approvals.actionId, caseActions.map((a) => a.id)))
          .orderBy(desc(approvals.requestedAt))
      : [];

    const caseCalls = await tx
      .select()
      .from(calls)
      .where(eq(calls.employeeId, row.employee.id))
      .orderBy(desc(calls.id))
      .limit(10);

    const manager = row.employee.managerEmployeeId
      ? await tx.query.employees.findFirst({ where: eq(employees.id, row.employee.managerEmployeeId) })
      : null;

    const otherPending = await tx
      .select({ id: cases.id, attDate: cases.attDate, status: cases.status })
      .from(cases)
      .where(
        and(
          eq(cases.employeeId, row.employee.id),
          inArray(cases.status, ['queued', 'asked', 'delivered', 'read']),
          sql`${cases.id} <> ${caseId}`,
        ),
      )
      .orderBy(asc(cases.attDate));

    return { ...row, transcript, calls: caseCalls, actions: caseActions, approvals: caseApprovals, manager, otherPending };
  });
}

export async function mappingOverview(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const profile = await tx.query.mappingProfiles.findFirst({
      where: and(eq(mappingProfiles.tenantId, tenantId), eq(mappingProfiles.status, 'active')),
    });
    const codes = profile
      ? await tx.select().from(codeMappings).where(eq(codeMappings.profileId, profile.id)).orderBy(asc(codeMappings.code))
      : [];
    const unmapped = await tx
      .select()
      .from(unmappedCodes)
      .where(eq(unmappedCodes.tenantId, tenantId))
      .orderBy(desc(unmappedCodes.occurrences));
    const recentImports = await tx
      .select()
      .from(imports)
      .where(eq(imports.tenantId, tenantId))
      .orderBy(desc(imports.startedAt))
      .limit(5);
    return { profile, codes, unmapped, recentImports };
  });
}

export async function tenantSummary(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    const settings = await tx.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, tenantId) });
    return { tenant, settings };
  });
}

/** Cross-customer view for the Talent Carriage console. */
export async function platformOverview() {
  return withPlatformScope(async (tx) => {
    const rows = await tx
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        sendingEnabled: tenantSettings.sendingEnabled,
        operatingMode: tenantSettings.operatingMode,
        actionsEnabled: tenantSettings.actionsEnabled,
        checkTime: tenantSettings.checkTime,
        cap: tenantSettings.maxOutstandingQuestions,
      })
      .from(tenants)
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
      .orderBy(asc(tenants.name));

    const counts = await tx
      .select({ tenantId: cases.tenantId, status: cases.status, total: count() })
      .from(cases)
      .groupBy(cases.tenantId, cases.status);

    const employeeCounts = await tx
      .select({ tenantId: employees.tenantId, total: count() })
      .from(employees)
      .groupBy(employees.tenantId);

    return rows.map((tenant) => {
      const mine = counts.filter((c) => c.tenantId === tenant.id);
      return {
        ...tenant,
        employees: employeeCounts.find((e) => e.tenantId === tenant.id)?.total ?? 0,
        cases: mine.reduce((sum, c) => sum + c.total, 0),
        awaiting: mine.filter((c) => ['asked', 'delivered', 'read'].includes(c.status)).reduce((s, c) => s + c.total, 0),
        attention: mine.filter((c) => ['needs_hr', 'failed'].includes(c.status)).reduce((s, c) => s + c.total, 0),
      };
    });
  });
}

export async function listTenantsForSwitcher() {
  return withPlatformScope((tx) =>
    tx.select({ id: tenants.id, name: tenants.name, slug: tenants.slug }).from(tenants).orderBy(asc(tenants.name)),
  );
}

export type FlaggedRow = {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  department: string | null;
  mobile: string | null;
  attDate: string;
  meaning: string;
  rawStatus: string | null;
  preferredChannel: string;
  operatingMode: string | null;
  caseId: string | null;
  caseStatus: string | null;
};

/**
 * Everyone with an attendance gap in a date range, with their case if one
 * exists. This is what the dashboard shows: the people, their switches, and
 * whether they have been contacted yet.
 */
export async function flaggedInRange(tenantId: string, from: string, to: string): Promise<FlaggedRow[]> {
  const { settings } = await tenantSummary(tenantId);
  if (!settings) return [];

  return withTenant(tenantId, async (tx) => {
    const meanings = chasedMeanings(settings);
    const rows = await tx
      .select({
        employeeId: employees.id,
        employeeName: employees.fullName,
        employeeCode: employees.empCode,
        department: employees.department,
        mobile: employees.mobileE164,
        preferredChannel: employees.preferredChannel,
        operatingMode: employees.operatingMode,
        attDate: attendanceDays.attDate,
        meaning: attendanceDays.meaning,
        rawStatus: attendanceDays.rawStatus,
        isWorkingDay: attendanceDays.isWorkingDay,
        caseId: cases.id,
        caseStatus: cases.status,
      })
      .from(attendanceDays)
      .innerJoin(employees, eq(employees.id, attendanceDays.employeeId))
      .leftJoin(cases, and(eq(cases.employeeId, employees.id), eq(cases.attDate, attendanceDays.attDate)))
      .where(
        and(
          eq(attendanceDays.tenantId, tenantId),
          gte(attendanceDays.attDate, from),
          lte(attendanceDays.attDate, to),
          inArray(attendanceDays.meaning, meanings),
        ),
      )
      .orderBy(desc(attendanceDays.attDate), asc(employees.fullName))
      .limit(500);

    return rows.filter((r) => r.isWorkingDay).map(({ isWorkingDay, ...row }) => row);
  });
}

/** The most recent date that already has cases, for a useful default view. */
export async function latestCaseDate(tenantId: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ attDate: cases.attDate })
      .from(cases)
      .where(eq(cases.tenantId, tenantId))
      .orderBy(desc(cases.attDate))
      .limit(1);
    return row?.attDate ?? null;
  });
}

/** Dates with attendance data, so the check form can offer sensible choices. */
export async function availableDates(tenantId: string, limit = 40) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ attDate: attendanceDays.attDate })
      .from(attendanceDays)
      .where(eq(attendanceDays.tenantId, tenantId))
      .groupBy(attendanceDays.attDate)
      .orderBy(desc(attendanceDays.attDate))
      .limit(limit);
    return rows.map((r) => r.attDate);
  });
}
