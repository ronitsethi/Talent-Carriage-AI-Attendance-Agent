import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { withTenant } from '@/db';
import { cases, employees, imports } from '@/db/schema';
import { capAllows, outstandingCount, type TenantSettings } from '@/lib/conversation/engine';
import { followUpDueOnUpload, sendFollowUpsAfterUpload } from '@/lib/conversation/followup';
import { channelFor } from '@/lib/channel';
import { contactCaseById } from '@/lib/contact';
import { MAX_RANGE_DAYS, datesInRange } from '@/lib/dates';
import { contactDateFor, findGaps, runDailyCheck } from '@/lib/detection/run';
import { enqueue } from '@/lib/jobs/queue';
import { buildContext, type FullContext } from '@/lib/runtime';
import { lockedMonths, monthOf } from '@/lib/locks';

/**
 * Sending after an attendance upload: the only way anything goes out on its own.
 *
 * Every upload updates the attendance and settles what it explains. With
 * automatic sending on, HR is then offered the choice of also sending what is
 * due: first questions for the unopened dates, and a follow-up for anyone who
 * answered before today and whose date the file still shows unexplained. Sending
 * starts after the customer's time period, each person a job of their own, so
 * nothing waits on the upload's request and one person's failure stays theirs.
 * Until the next upload, nothing else is sent.
 */

export type SendStage = 'first_contact' | 'follow_up';

/**
 * Follow-ups go before first questions: both are due at once, and the queue takes
 * the follow-ups' jobs first. Calls then take the shared lines in that order, and
 * someone due both is never rung twice at once (`voice/lines.ts`).
 */
const PRIORITY: Record<SendStage, number> = { follow_up: 3, first_contact: 5 };

type ModeSettings = Pick<TenantSettings, 'operatingMode' | 'attendanceSource'>;

/** Automatic sending needs a file to follow, so an HRMS customer never has it. */
export const automaticUploads = (settings: ModeSettings) => settings.operatingMode === 'automatic' && settings.attendanceSource === 'csv';

const isAutomatic = (employee: { operatingMode: string | null }, settings: ModeSettings) =>
  (employee.operatingMode ?? settings.operatingMode) === 'automatic';

/** Whether this person is reached after uploads, rather than by HR from the dashboard. */
export const followsUploads = (employee: { operatingMode: string | null }, settings: ModeSettings) =>
  automaticUploads(settings) && isAutomatic(employee, settings);

/** The file's dates that are final enough to chase, newest kept when there are too many. */
function datesToChase(upload: { dateFrom: string | null; dateTo: string | null }, settings: TenantSettings, at: Date): string[] {
  if (!upload.dateFrom || !upload.dateTo) return [];
  const last = [upload.dateTo, contactDateFor(settings, at)].sort()[0]!;
  const earliest = new Date(new Date(`${last}T00:00:00Z`).getTime() - (MAX_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  return datesInRange([upload.dateFrom, earliest].sort()[1]!, last);
}

/** The newest finished import, if it is the one asked about: an old link sends nothing. */
async function latestUpload(ctx: FullContext, importId: string) {
  const [latest] = await ctx.tx
    .select()
    .from(imports)
    .where(and(eq(imports.tenantId, ctx.tenantId), inArray(imports.status, ['completed', 'partial'])))
    .orderBy(desc(imports.startedAt))
    .limit(1);
  return latest?.id === importId ? latest : null;
}

/** Who a send would reach. Changes nothing. `dates` overrides the upload's own: an unlock's months. */
async function planSend(ctx: FullContext, upload: { dateFrom: string | null; dateTo: string | null }, at: Date, dates?: string[]) {
  const firstContact = new Set<string>();
  const followUps = new Set<string>();
  const newDates: string[] = [];
  const locked = await lockedMonths(ctx.tx, ctx.tenantId);

  for (const date of (dates ?? datesToChase(upload, ctx.settings, at)).filter((d) => !locked.has(monthOf(d)))) {
    const { gaps } = await findGaps(ctx.tx, ctx.tenantId, date, ctx.settings, { automaticOnly: true });
    const fresh = gaps.filter((gap) => !gap.existingCaseId);
    if (fresh.length) newDates.push(date);
    for (const gap of fresh) firstContact.add(gap.employeeId);
  }

  const open = await ctx.tx
    .select({ status: cases.status, employeeId: cases.employeeId, operatingMode: employees.operatingMode })
    .from(cases)
    .innerJoin(employees, eq(employees.id, cases.employeeId))
    .where(
      and(
        eq(cases.tenantId, ctx.tenantId),
        isNull(employees.deletedAt),
        or(
          and(eq(cases.status, 'queued'), lte(cases.attDate, contactDateFor(ctx.settings, at))),
          followUpDueOnUpload(ctx.settings.timezone, at),
        ),
      ),
    );
  for (const row of open) {
    if (!isAutomatic(row, ctx.settings)) continue;
    (row.status === 'queued' ? firstContact : followUps).add(row.employeeId);
  }

  return { firstContact: [...firstContact], followUps: [...followUps], newDates };
}

/** What the choice after an upload would do, or null when there is no choice to offer. */
export async function previewUploadSend(tenantId: string, importId: string, at = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (!automaticUploads(ctx.settings)) return null;
    const upload = await latestUpload(ctx, importId);
    if (!upload) return null;
    const { firstContact, followUps } = await planSend(ctx, upload, at);
    return {
      people: new Set([...firstContact, ...followUps]).size,
      firstContact: firstContact.length,
      followUps: followUps.length,
      delayMinutes: ctx.settings.sendDelayMinutes,
      sendingEnabled: ctx.settings.sendingEnabled,
    };
  });
}

/**
 * HR chose to send: the new dates become cases, and each person's contact is
 * queued for when the time period ends. Choosing twice queues nothing new.
 */
export async function startUploadSend(tenantId: string, importId: string, at = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (!automaticUploads(ctx.settings)) return { people: 0, delayMinutes: 0 };
    const upload = await latestUpload(ctx, importId);
    if (!upload) return { people: 0, delayMinutes: 0 };

    const { firstContact, followUps, newDates } = await planSend(ctx, upload, at);
    for (const date of newDates) {
      await runDailyCheck(ctx, { date, trigger: 'import', createOnly: true, importId });
    }

    const people = await queueSends(ctx, { firstContact, followUps }, at, importId);
    return { people, delayMinutes: ctx.settings.sendDelayMinutes };
  });
}

/** Each person's turn, queued for when the customer's time period ends. Returns how many people. */
async function queueSends(ctx: FullContext, plan: { firstContact: string[]; followUps: string[] }, at: Date, key: string) {
  const runAt = new Date(at.getTime() + ctx.settings.sendDelayMinutes * 60_000);
  const stages: { employeeId: string; stage: SendStage }[] = [
    ...plan.followUps.map((employeeId) => ({ employeeId, stage: 'follow_up' as const })),
    ...plan.firstContact.map((employeeId) => ({ employeeId, stage: 'first_contact' as const })),
  ];
  for (const { employeeId, stage } of stages) {
    await enqueue(
      'upload_contact',
      { employeeId, stage },
      { tenantId: ctx.tenantId, runAt, priority: PRIORITY[stage], dedupeKey: `upload_contact:${key}:${stage}:${employeeId}` },
      ctx.tx,
    );
  }
  return new Set(stages.map((s) => s.employeeId)).size;
}

/** Every date of these months, up to the date contact is due, oldest first. */
function datesOfMonths(months: string[], settings: TenantSettings, at: Date): string[] {
  const last = contactDateFor(settings, at);
  return months
    .flatMap((month) => {
      const [year, number] = month.split('-').map(Number) as [number, number];
      const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
      return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    })
    .filter((date) => date <= last)
    .sort();
}

/**
 * What the choice after an unlock would send, or null when there is no choice
 * to offer (a customer not on automatic). The same as after an upload, over the
 * unlocked months: their unopened dates, and anyone due a follow-up.
 */
export async function previewUnlockSend(tenantId: string, months: string[], at = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (!automaticUploads(ctx.settings) || !months.length) return null;
    const { firstContact, followUps } = await planSend(ctx, { dateFrom: null, dateTo: null }, at, datesOfMonths(months, ctx.settings, at));
    return {
      people: new Set([...firstContact, ...followUps]).size,
      firstContact: firstContact.length,
      followUps: followUps.length,
      delayMinutes: ctx.settings.sendDelayMinutes,
      sendingEnabled: ctx.settings.sendingEnabled,
    };
  });
}

/** HR chose to send after unlocking: as after an upload, over the unlocked months. */
export async function startUnlockSend(tenantId: string, months: string[], at = new Date()) {
  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    if (!automaticUploads(ctx.settings) || !months.length) return { people: 0, delayMinutes: 0 };
    const { firstContact, followUps, newDates } = await planSend(ctx, { dateFrom: null, dateTo: null }, at, datesOfMonths(months, ctx.settings, at));
    for (const date of newDates) await runDailyCheck(ctx, { date, trigger: 'import', createOnly: true });
    const people = await queueSends(ctx, { firstContact, followUps }, at, `unlock:${months.join(',')}:${at.getTime()}`);
    return { people, delayMinutes: ctx.settings.sendDelayMinutes };
  });
}

/**
 * One person's turn. Everything is checked again, because the time period can be
 * long: the switch may be off now, they may have been set to Manual, or a date
 * may be closed. What cannot go now stays due for the next upload.
 */
export async function contactAfterUpload(tenantId: string, employeeId: string, stage: SendStage, at = new Date()) {
  const plan = await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    const employee = await tx.query.employees.findFirst({ where: eq(employees.id, employeeId) });
    if (!employee || employee.deletedAt) return { skipped: 'employee is gone' };
    if (!followsUploads(employee, ctx.settings)) return { skipped: 'no longer automatic' };

    if (stage === 'follow_up') return { followUps: await sendFollowUpsAfterUpload(ctx, employeeId, at) };

    const unopened = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.employeeId, employeeId), eq(cases.status, 'queued'), lte(cases.attDate, contactDateFor(ctx.settings, at))))
      .orderBy(asc(cases.attDate));
    const outstanding = await outstandingCount(ctx, employeeId);
    if (!unopened.length || !capAllows(ctx.settings, outstanding)) return { caseIds: [] };

    // One call, about the newest date, which sweeps the rest; on WhatsApp each date
    // has its own message, as many as the cap leaves room for.
    if (channelFor(employee, ctx.settings.defaultChannel) === 'voice') return { caseIds: [unopened[unopened.length - 1]!.id] };
    const cap = ctx.settings.maxOutstandingQuestions;
    return { caseIds: (cap > 0 ? unopened.slice(0, cap - outstanding) : unopened).map((row) => row.id) };
  });

  let contacted = 0;
  for (const caseId of plan.caseIds ?? []) {
    const outcome = await withTenant(tenantId, async (tx) => contactCaseById(await buildContext(tx, tenantId), caseId));
    if (outcome?.contacted) contacted++;
  }
  return { ...plan, contacted };
}
