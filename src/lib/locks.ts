import { and, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { actions, approvals, attendanceDays, attendanceLocks, cases, type LockState } from '@/db/schema';

/**
 * Locking a month's attendance: an admin makes it final.
 *
 * While a month is locked -
 *  - no upload writes its days (the rest of the file still imports);
 *  - nobody is contacted about it: no first question, follow-up, final notice
 *    or manager request, from a send or from the portal, and its rows show with
 *    every control disabled;
 *  - every case of it still open waits as `unresolved`, with where it stood kept
 *    in `lock_state`; a reply about it, from the employee or the manager, gets
 *    one "it is locked" answer and changes nothing.
 * Unlocking puts each case back where it stood, a manager's remaining time with
 * it. What is then due can be sent, as after an upload.
 */

export const LOCKED_REASON = 'Attendance for this month is locked';

/** YYYY-MM of a YYYY-MM-DD date. */
export const monthOf = (date: string) => date.slice(0, 7);

/** "October", or "October 2025" outside the current year. */
export function monthLabel(month: string, at = new Date()): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const name = new Date(Date.UTC(year, number - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return year === at.getUTCFullYear() ? name : `${name} ${year}`;
}

/** The first day of a month and of the one after, as dates. */
function bounds(month: string): [string, string] {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const next = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
}

export const isMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

export async function lockedMonths(tx: Db, tenantId: string): Promise<Set<string>> {
  const rows = await tx.select({ month: attendanceLocks.month }).from(attendanceLocks).where(eq(attendanceLocks.tenantId, tenantId));
  return new Set(rows.map((row) => row.month));
}

export async function isLocked(tx: Db, tenantId: string, date: string): Promise<boolean> {
  const [row] = await tx
    .select({ month: attendanceLocks.month })
    .from(attendanceLocks)
    .where(and(eq(attendanceLocks.tenantId, tenantId), eq(attendanceLocks.month, monthOf(date))))
    .limit(1);
  return Boolean(row);
}

/** The locks, newest month first, for the portal. */
export async function listLocks(tx: Db, tenantId: string) {
  return tx.select().from(attendanceLocks).where(eq(attendanceLocks.tenantId, tenantId)).orderBy(sql`${attendanceLocks.month} desc`);
}

/** Months that have attendance and could be locked, newest first. */
export async function monthsWithAttendance(tx: Db, tenantId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ month: sql<string>`to_char(${attendanceDays.attDate}, 'YYYY-MM')` })
    .from(attendanceDays)
    .where(eq(attendanceDays.tenantId, tenantId));
  return rows.map((row) => row.month).sort().reverse();
}

const DONE = ['resolved', 'cancelled', 'unresolved'] as const;

/**
 * Locks a month. Every case of it still open becomes `unresolved`, remembering
 * its status and how long each waiting manager request had left. Locking a
 * month already locked changes nothing.
 */
export async function lockMonth(tx: Db, tenantId: string, month: string, userId: string | null, at = new Date()): Promise<{ cases: number }> {
  if (!isMonth(month)) throw new Error('Choose a month to lock');
  const [inserted] = await tx
    .insert(attendanceLocks)
    .values({ tenantId, month, lockedAt: at, lockedBy: userId })
    .onConflictDoNothing()
    .returning();
  if (!inserted) return { cases: 0 };

  const [from, to] = bounds(month);
  const open = await tx
    .select({ id: cases.id, status: cases.status })
    .from(cases)
    .where(and(eq(cases.tenantId, tenantId), gte(cases.attDate, from), lt(cases.attDate, to), notInArray(cases.status, [...DONE])));
  if (!open.length) return { cases: 0 };

  const pending = await tx
    .select({ id: approvals.id, caseId: actions.caseId, timeoutAt: approvals.timeoutAt })
    .from(approvals)
    .innerJoin(actions, eq(actions.id, approvals.actionId))
    .where(and(eq(approvals.decision, 'pending'), inArray(actions.caseId, open.map((row) => row.id))));

  for (const row of open) {
    const left = Object.fromEntries(
      pending.filter((p) => p.caseId === row.id).map((p) => [p.id, Math.max(0, (p.timeoutAt?.getTime() ?? at.getTime()) - at.getTime())]),
    );
    const state: LockState = { status: row.status, lockedAt: at.toISOString(), ...(Object.keys(left).length ? { approvals: left } : {}) };
    await tx.update(cases).set({ status: 'unresolved', lockState: state, updatedAt: at }).where(eq(cases.id, row.id));
  }
  return { cases: open.length };
}

/**
 * Unlocks months. Each case goes back to the status it was locked in, and a
 * manager's request gets the time it had left when it was locked.
 */
export async function unlockMonths(tx: Db, tenantId: string, months: string[], at = new Date()): Promise<{ months: string[]; cases: number }> {
  const wanted = [...new Set(months.filter(isMonth))];
  if (!wanted.length) return { months: [], cases: 0 };
  const removed = await tx
    .delete(attendanceLocks)
    .where(and(eq(attendanceLocks.tenantId, tenantId), inArray(attendanceLocks.month, wanted)))
    .returning({ month: attendanceLocks.month });

  let restored = 0;
  for (const { month } of removed) {
    const [from, to] = bounds(month);
    const locked = await tx
      .select({ id: cases.id, lockState: cases.lockState })
      .from(cases)
      .where(and(eq(cases.tenantId, tenantId), gte(cases.attDate, from), lt(cases.attDate, to), eq(cases.status, 'unresolved')));
    for (const row of locked) {
      const state = row.lockState;
      await tx
        .update(cases)
        .set({ status: (state?.status ?? 'queued') as typeof cases.$inferSelect.status, lockState: null, updatedAt: at })
        .where(eq(cases.id, row.id));
      for (const [approvalId, left] of Object.entries(state?.approvals ?? {})) {
        await tx
          .update(approvals)
          .set({ timeoutAt: new Date(at.getTime() + left) })
          .where(and(eq(approvals.id, approvalId), eq(approvals.decision, 'pending')));
      }
      restored++;
    }
  }
  return { months: removed.map((row) => row.month).sort(), cases: restored };
}

/** What an employee who writes about a locked date is told, once. */
export const employeeLockReply = (firstName: string, month: string) =>
  `Hi ${firstName}, your attendance for ${monthLabel(month)} has been locked, so this can no longer be changed here. Please speak to your manager about it.`;

/** What a manager who decides a request about a locked date is told, once. */
export const managerLockReply = (month: string, employee: { fullName: string; empCode: string }) =>
  `${monthLabel(month)}'s attendance for ${employee.fullName} (${employee.empCode}) has been locked, so no action is needed on this request.`;

/**
 * Marks the one reply about a locked case as sent to `who`. False when it had
 * already gone, so the caller stays quiet.
 */
export async function claimLockReply(tx: Db, caseId: string, who: 'employee' | 'manager', at = new Date()): Promise<boolean> {
  const row = await tx.query.cases.findFirst({ where: eq(cases.id, caseId), columns: { lockState: true, status: true } });
  if (!row || row.status !== 'unresolved' || !row.lockState) return false;
  const field = who === 'employee' ? 'employeeToldAt' : 'managerToldAt';
  if (row.lockState[field]) return false;
  await tx.update(cases).set({ lockState: { ...row.lockState, [field]: at.toISOString() } }).where(eq(cases.id, caseId));
  return true;
}
