import { and, asc, eq, inArray } from 'drizzle-orm';
import { cases } from '@/db/schema';
import { today } from '@/lib/dates';
import { managerFirstName } from '@/lib/approvals';
import { datesLabel } from './absence-group';
import { isOnLeave, needsApplication, submitApplication, type ApplyContext } from './apply';
import { UNANSWERED, type CaseRow, type EmployeeRow, type EngineContext } from './engine';
import { DAYS_TO_ACT, formatDate } from './flow';
import { OUTCOMES, type ApplicationStage, type LeaveChoice, type OutcomeCode } from './outcomes';
import { recordOutcome, type OtherDates } from './talk';
import { spokenDate } from './voice-script';

/**
 * One reply, several dates. "Sick all three days" puts one answer on each of
 * them; "the 3rd I was sick, the 6th I was working" gives each its own. Every
 * date is recorded on its own case exactly as if it had been asked alone - its
 * status, its follow-ups, its manager request - only the asking is shared.
 */

/** The open cases for these dates (YYYY-MM-DD), oldest first. Dates not open, or not theirs, are left out. */
export async function openCasesFor(ctx: EngineContext, employeeId: string, dates: string[]): Promise<CaseRow[]> {
  const wanted = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))];
  if (!wanted.length) return [];
  return ctx.tx
    .select()
    .from(cases)
    .where(and(eq(cases.employeeId, employeeId), inArray(cases.attDate, wanted), inArray(cases.status, [...UNANSWERED])))
    .orderBy(asc(cases.attDate));
}

/** An answer complete enough to write down: the outcome, leave or Loss of Pay where asked, and where an application stands. */
function complete(entry: OtherDates): { code: OutcomeCode; choice: LeaveChoice | null; stage: ApplicationStage | null } | null {
  if (entry.outcome === 'none' || !OUTCOMES[entry.outcome]) return null;
  const code = entry.outcome;
  const choice = entry.leave_choice === 'not_said' ? null : entry.leave_choice;
  if (OUTCOMES[code].asksLeaveOrLossOfPay && !choice) return null;
  const stage = entry.application === 'not_said' ? (isOnLeave(code) ? null : OUTCOMES[code].application?.preset ?? null) : entry.application;
  if (needsApplication(code, choice) && !stage) return null;
  return { code, choice, stage };
}

/**
 * Writes down the answers given for other dates in the same reply. Only
 * complete ones: a date still missing something is asked about in its turn,
 * with what they said already in the conversation. Anything applied for goes
 * to the manager as one request for those dates. Returns the cases written.
 */
export async function settleOtherDates(
  ctx: EngineContext,
  employee: EmployeeRow,
  entries: OtherDates[],
  via: 'whatsapp' | 'call',
): Promise<CaseRow[]> {
  const written: CaseRow[] = [];
  for (const entry of entries) {
    const answer = complete(entry);
    if (!answer) continue;
    const rows = await openCasesFor(ctx, employee.id, entry.dates);
    if (!rows.length) continue;
    const manager = await managerFirstName(ctx.tx, ctx.tenantId, employee);
    for (const row of rows) await recordOutcome({ ...ctx, companyName: '' }, row, employee, answer.code, answer.choice, entry.note, manager, via);
    if (needsApplication(answer.code, answer.choice) && answer.stage) {
      const due = new Date(`${today(ctx.settings.timezone)}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + DAYS_TO_ACT);
      const deadline = due.toISOString().slice(0, 10);
      const [lead, ...alsoCases] = rows;
      const fresh = (await ctx.tx.query.cases.findFirst({ where: eq(cases.id, lead!.id) })) ?? lead!;
      await submitApplication(ctx as ApplyContext, fresh, employee, {
        code: answer.code,
        choice: answer.choice,
        stage: answer.stage,
        note: entry.note,
        via,
        facts: { date: datesLabel(rows), deadline: via === 'call' ? spokenDate(deadline) : formatDate(deadline), manager },
        alsoCases,
      });
    }
    written.push(...rows);
  }
  return written;
}
