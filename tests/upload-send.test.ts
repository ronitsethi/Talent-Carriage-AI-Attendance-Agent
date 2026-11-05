import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { actions, approvals, cases, employees, imports, jobs, tenantSettings } from '@/db/schema';
import { closeCasesExplainedByData } from '@/lib/detection/run';
import { scheduleDueWork } from '@/lib/jobs/scheduler';
import type { TenantSettings } from '@/lib/conversation/engine';
import { contactAfterUpload, previewUploadSend, startUploadSend } from '@/lib/upload-send';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * Automatic sending after an attendance upload: what every upload settles by
 * itself, and what HR choosing to send then does.
 */

const DATE = '2026-08-17';
let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const automatic = (settings: Partial<TenantSettings> = {}, employee = {}) =>
  makeScenario({ operatingMode: 'automatic', attendanceSource: 'csv', sendDelayMinutes: 60, ...settings }, employee);

/** An uploaded file showing the employee absent on `date`. */
async function upload(date = DATE) {
  return withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date, meaning: 'absent_full', raw: 'A|A' }]);
    const [row] = await tx
      .insert(imports)
      .values({ tenantId: scenario.tenantId, source: 'upload', status: 'completed', dateFrom: date, dateTo: date })
      .returning();
    return row!.id;
  });
}

const sent = () => scenario.channel.history().map((s) => s.message as unknown as { templateName?: string });
const allCases = () => withTenant(scenario.tenantId, (tx) => tx.select().from(cases));
const queuedJobs = () => withTenant(scenario.tenantId, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'upload_contact')));
const addCase = (values: Partial<typeof cases.$inferInsert>) =>
  withTenant(scenario.tenantId, async (tx) => {
    const [row] = await tx
      .insert(cases)
      .values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, attDate: DATE, meaning: 'absent_full', ...values })
      .returning();
    return row!;
  });
const setAttendance = (meaning: 'leave_approved' | 'absent_full') =>
  withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: DATE, meaning }]);
    return closeCasesExplainedByData(tx, scenario.tenantId);
  });

describe('what every upload settles', () => {
  it('resolves a contacted case the file now explains, marked as closed by the data', async () => {
    scenario = await automatic();
    const row = await addCase({ status: 'answered', replyOption: 1, followUpDueAt: new Date() });

    expect(await setAttendance('leave_approved')).toEqual({ closed: 1, removed: 0 });

    const [after] = await allCases();
    expect(after).toMatchObject({ id: row.id, status: 'resolved', closedByRevision: true, followUpDueAt: null });
  });

  it('deletes an unopened case the file now explains', async () => {
    scenario = await automatic();
    await addCase({ status: 'queued' });

    expect(await setAttendance('leave_approved')).toEqual({ closed: 0, removed: 1 });
    expect(await allCases()).toEqual([]);
  });

  it('leaves a case alone while the day is still an absence', async () => {
    scenario = await automatic();
    await addCase({ status: 'queued' });

    expect(await setAttendance('absent_full')).toEqual({ closed: 0, removed: 0 });
    expect(await allCases()).toHaveLength(1);
  });

  it('takes a request back from the manager once the file shows it was done', async () => {
    scenario = await automatic();
    const row = await addCase({ status: 'awaiting_approval' });
    await withTenant(scenario.tenantId, async (tx) => {
      const [action] = await tx
        .insert(actions)
        .values({
          tenantId: scenario.tenantId,
          caseId: row.id,
          employeeId: scenario.employeeId,
          type: 'apply_leave',
          status: 'awaiting_approval',
          inputs: {},
          idempotencyKey: 'test',
        })
        .returning();
      await tx.insert(approvals).values({ tenantId: scenario.tenantId, actionId: action!.id, timeoutAt: new Date() });
    });

    await setAttendance('leave_approved');

    expect((await allCases())[0]!.status).toBe('resolved');
    const left = await withTenant(scenario.tenantId, (tx) => tx.select().from(approvals));
    expect(left[0]!.decision).toBe('expired');
  });
});

describe('the choice after an upload', () => {
  it('is offered with automatic on and CSV upload, and counts who is due', async () => {
    scenario = await automatic();
    const preview = await previewUploadSend(scenario.tenantId, await upload());
    expect(preview).toMatchObject({ people: 1, firstContact: 1, followUps: 0, delayMinutes: 60 });
    expect(sent(), 'choosing has not happened yet').toEqual([]);
  });

  it('is not offered in manual mode, with an HRMS, or for an older upload', async () => {
    scenario = await makeScenario({ operatingMode: 'manual' });
    expect(await previewUploadSend(scenario.tenantId, await upload())).toBeNull();
    await scenario.cleanup();

    scenario = await automatic({ attendanceSource: 'hrms' });
    expect(await previewUploadSend(scenario.tenantId, await upload())).toBeNull();
    await scenario.cleanup();

    scenario = await automatic();
    const older = await upload('2026-08-17');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await upload('2026-08-18');
    expect(await previewUploadSend(scenario.tenantId, older)).toBeNull();
  });

  it('leaves out employees set to Manual, and today, whose attendance is not final', async () => {
    scenario = await automatic({}, { operatingMode: 'manual' });
    expect((await previewUploadSend(scenario.tenantId, await upload()))!.people).toBe(0);
    await scenario.cleanup();

    scenario = await automatic();
    const now = new Date();
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
    expect((await previewUploadSend(scenario.tenantId, await upload(local), now))!.people).toBe(0);
  });
});

describe('sending', () => {
  it('sends nothing at once: everyone starts when the time period ends', async () => {
    scenario = await automatic({ sendDelayMinutes: 60 });
    await withTenant(scenario.tenantId, (tx) =>
      tx.insert(employees).values({ tenantId: scenario.tenantId, empCode: 'E-2', fullName: 'Second Person', mobileE164: '919000099999' }),
    );
    const importId = await upload();
    await withTenant(scenario.tenantId, async (tx) => {
      const second = await tx.query.employees.findFirst({ where: eq(employees.empCode, 'E-2') });
      await giveAttendance(tx, scenario.tenantId, second!.id, [{ date: DATE, meaning: 'absent_full', raw: 'A|A' }]);
    });

    const at = new Date();
    const result = await startUploadSend(scenario.tenantId, importId, at);

    expect(result).toEqual({ people: 2, delayMinutes: 60 });
    expect(sent()).toEqual([]);
    expect((await allCases()).map((c) => c.status)).toEqual(['queued', 'queued']);
    const offsets = (await queuedJobs()).map((job) => (job.runAt.getTime() - at.getTime()) / 60_000).sort((a, b) => a - b);
    expect(offsets).toEqual([60, 60]);
  });

  it('queues nothing new when chosen twice', async () => {
    scenario = await automatic();
    const importId = await upload();
    await startUploadSend(scenario.tenantId, importId);
    await startUploadSend(scenario.tenantId, importId);
    expect(await queuedJobs()).toHaveLength(1);
  });

  it('asks about old and new unopened dates, and sends a follow-up that is due', async () => {
    scenario = await automatic();
    await addCase({ attDate: '2026-08-10', status: 'queued' });
    const dayBefore = new Date(Date.now() - 86_400_000);
    await addCase({ attDate: '2026-08-11', status: 'answered', replyOption: 1, answeredAt: dayBefore, followUpDueAt: new Date(Date.now() + 86_400_000) });
    await addCase({ attDate: '2026-08-12', status: 'answered', replyOption: 1, answeredAt: new Date(), followUpDueAt: new Date(Date.now() + 86_400_000) });
    const importId = await upload();

    expect(await previewUploadSend(scenario.tenantId, importId)).toMatchObject({ people: 1, firstContact: 1, followUps: 1 });
    await startUploadSend(scenario.tenantId, importId);
    const queued = await queuedJobs();
    expect(queued.map((job) => job.payload.stage).sort()).toEqual(['first_contact', 'follow_up']);
    const runAt = (stage: string) => queued.find((job) => job.payload.stage === stage)!.runAt.getTime();
    expect(runAt('follow_up') - runAt('first_contact'), 'not rung twice at once').toBe(10 * 60_000);

    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'first_contact');
    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'follow_up');

    const rows = await allCases();
    const on = (date: string) => rows.find((row) => row.attDate === date)!;
    expect(on('2026-08-10').status).toBe('asked');
    expect(on(DATE).status).toBe('asked');
    expect(on('2026-08-11').followUpCount, 'answered on an earlier day').toBe(1);
    expect(on('2026-08-12').followUpCount, 'answered today').toBe(0);
  });

  it('follows up the day after, along with that day\'s new absence', async () => {
    scenario = await automatic({ sendDelayMinutes: 0 });
    // Absent on the 17th, asked and answered on the 18th.
    await addCase({
      status: 'answered',
      replyOption: 1,
      answeredAt: new Date('2026-08-18T06:00:00Z'),
      followUpDueAt: new Date('2026-08-23T06:00:00Z'),
    });

    const onThe19th = new Date('2026-08-19T06:00:00Z');
    const importId = await upload('2026-08-18');
    expect(await previewUploadSend(scenario.tenantId, importId, onThe19th)).toMatchObject({ people: 1, firstContact: 1, followUps: 1 });
    await startUploadSend(scenario.tenantId, importId, onThe19th);
    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'first_contact', onThe19th);
    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'follow_up', onThe19th);

    const rows = await allCases();
    expect(rows.find((row) => row.attDate === DATE)!.followUpCount).toBe(1);
    expect(rows.find((row) => row.attDate === '2026-08-18')!.status).toBe('asked');
  });

  it('sends one follow-up a day, however many files go up', async () => {
    scenario = await automatic({ maxFollowUps: 3 });
    const at = new Date('2026-08-19T06:00:00Z');
    await addCase({
      status: 'answered',
      replyOption: 1,
      answeredAt: new Date('2026-08-18T06:00:00Z'),
      followUpDueAt: new Date('2026-08-18T07:00:00Z'),
    });
    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'follow_up', at);
    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'follow_up', new Date(at.getTime() + 3_600_000));
    expect((await allCases())[0]!.followUpCount).toBe(1);

    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'follow_up', new Date(at.getTime() + 86_400_000));
    expect((await allCases())[0]!.followUpCount).toBe(2);
  });

  it('counts the day in the customer\'s timezone, and never chases an ignored question', async () => {
    scenario = await automatic();
    // 00:30 on the 19th in India, the same day as the upload below.
    await addCase({ status: 'answered', replyOption: 1, answeredAt: new Date('2026-08-18T19:00:00Z'), followUpDueAt: new Date() });
    await addCase({ attDate: '2026-08-16', status: 'asked', followUpDueAt: null });

    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'follow_up', new Date('2026-08-19T06:00:00Z'));
    expect((await allCases()).map((row) => row.followUpCount)).toEqual([0, 0]);
    expect(sent()).toEqual([]);
  });

  it('checks again at their turn', async () => {
    scenario = await automatic();
    await startUploadSend(scenario.tenantId, await upload());

    await withTenant(scenario.tenantId, (tx) => tx.update(employees).set({ operatingMode: 'manual' }).where(eq(employees.id, scenario.employeeId)));
    expect(await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'first_contact')).toMatchObject({ skipped: 'no longer automatic', contacted: 0 });

    await withTenant(scenario.tenantId, async (tx) => {
      await tx.update(employees).set({ operatingMode: null }).where(eq(employees.id, scenario.employeeId));
      await tx.update(tenantSettings).set({ operatingMode: 'manual' }).where(eq(tenantSettings.tenantId, scenario.tenantId));
    });
    expect(await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'first_contact')).toMatchObject({ skipped: 'no longer automatic' });
    expect(sent()).toEqual([]);
  });

  it('goes at any hour', async () => {
    scenario = await automatic({ quietHoursStart: '00:00', quietHoursEnd: '23:59' });
    await startUploadSend(scenario.tenantId, await upload());

    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'first_contact');
    expect((await allCases())[0]!.status).toBe('asked');
  });

  it('does not contact a date closed since the send was chosen', async () => {
    scenario = await automatic();
    await startUploadSend(scenario.tenantId, await upload());
    await withTenant(scenario.tenantId, (tx) =>
      tx.update(cases).set({ status: 'resolved' }).where(and(eq(cases.tenantId, scenario.tenantId), eq(cases.attDate, DATE))),
    );

    await contactAfterUpload(scenario.tenantId, scenario.employeeId, 'first_contact');
    expect(sent()).toEqual([]);
  });
});

describe('the clock', () => {
  it('no longer queues anything that contacts an employee', async () => {
    scenario = await automatic();
    const { queued } = await scheduleDueWork(new Date('2026-11-01T06:00:00Z'));
    expect(queued.some((job) => /daily_check|send_follow_up|upload_contact/.test(job))).toBe(false);
  });
});
