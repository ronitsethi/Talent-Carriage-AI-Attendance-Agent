import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Deleting an employee, and what it leaves behind.
 *
 * The decision HR makes in the dialog is the whole of this feature: keep the
 * cases they are in the middle of as a record, or take everything. What must
 * never happen either way is a message or a call reaching somebody who has been
 * deleted - so the guards are tested from the outside, through the same
 * functions the daily check and the Contact buttons go through.
 */

const session = {
  userId: 'u1',
  email: 'hr@talentcarriage.test',
  name: 'HR Admin',
  role: 'platform_admin' as const,
  tenantId: null,
  departmentScope: [],
};

let activeTenantId = '';
const redirects: string[] = [];

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session,
  getActiveTenantId: async () => activeTenantId,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    redirects.push(url);
  },
}));

const { and, eq } = await import('drizzle-orm');
const { withTenant } = await import('@/db');
const { attendanceDays, cases, codeMappings, employees, mappingProfiles } = await import('@/db/schema');
const { deleteEmployee } = await import('@/app/actions');
const { contactCaseById } = await import('@/lib/contact');
const { handleInbound } = await import('@/lib/conversation/engine');
const { flaggedInRange, listEmployees } = await import('@/lib/queries');
const { runDailyCheck } = await import('@/lib/detection/run');
const { importAttendanceFile } = await import('@/lib/mapping/import');
const { presetByKey } = await import('@/lib/mapping/presets');
const { buildRowPerDayWorkbook, generatePeople } = await import('@/db/seed/generate');
const { makeScenario, giveAttendance, typeText } = await import('./helpers/scenario');

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

const ASKED = '2026-08-10';
const RESOLVED = '2026-08-11';
const UNSENT = '2026-08-12';

let scenario: Scenario;

afterEach(async () => {
  redirects.length = 0;
  await scenario?.cleanup();
});

/** One employee with a case in each of the three states a deletion cares about. */
async function setup() {
  scenario = await makeScenario();
  activeTenantId = scenario.tenantId;
  const { tenantId, employeeId } = scenario;

  return withTenant(tenantId, async (tx) => {
    await giveAttendance(tx, tenantId, employeeId, [
      { date: ASKED, meaning: 'absent_full' },
      { date: RESOLVED, meaning: 'absent_full' },
      { date: UNSENT, meaning: 'absent_full' },
    ]);
    const rows = await tx
      .insert(cases)
      .values([
        { tenantId, employeeId, attDate: ASKED, meaning: 'absent_full', status: 'asked', askedAt: new Date() },
        { tenantId, employeeId, attDate: RESOLVED, meaning: 'absent_full', status: 'resolved' },
        { tenantId, employeeId, attDate: UNSENT, meaning: 'absent_full', status: 'queued' },
      ])
      .returning();
    return { asked: rows.find((r) => r.attDate === ASKED)!.id };
  });
}

function form(employeeId: string, deleteOpenCases = false) {
  const data = new FormData();
  data.set('employeeId', employeeId);
  // An unticked checkbox submits nothing at all, which is what "keep them" is.
  if (deleteOpenCases) data.set('deleteOpenCases', 'on');
  return data;
}

const remaining = (tenantId: string, employeeId: string) =>
  withTenant(tenantId, async (tx) => ({
    employee: await tx.query.employees.findFirst({ where: eq(employees.id, employeeId) }),
    cases: await tx.select().from(cases).where(eq(cases.employeeId, employeeId)),
    days: await tx.select().from(attendanceDays).where(eq(attendanceDays.employeeId, employeeId)),
  }));

describe('deleting an employee', () => {
  it('keeps the open case as a record and deletes the rest of them', async () => {
    const { asked } = await setup();
    const { tenantId, employeeId } = scenario;

    await deleteEmployee(form(employeeId));

    const left = await remaining(tenantId, employeeId);
    expect(left.employee, 'the row stays, to hold the case up').toBeTruthy();
    expect(left.employee?.deletedAt).toBeTruthy();
    expect(left.cases.map((c) => c.id), 'only the case with a conversation behind it').toEqual([asked]);
    expect(left.days, 'their dashboard rows go').toHaveLength(0);
    expect(redirects[0]).toContain('kept=1');
  });

  it('never contacts them again, whichever button is pressed', async () => {
    const { asked } = await setup();
    const { tenantId, employeeId, channel, voice } = scenario;

    await deleteEmployee(form(employeeId));

    const outcome = await withTenant(tenantId, (tx) => contactCaseById(scenario.context(tx), asked));
    expect(outcome?.contacted).toBe(false);
    expect(outcome && !outcome.contacted && outcome.reason).toMatch(/deleted/i);
    expect(channel.history(), 'no message went out').toHaveLength(0);
    expect(voice.history(), 'no call was placed').toHaveLength(0);
  });

  it('ignores anything they send, so a frozen case cannot start moving again', async () => {
    await setup();
    const { tenantId, employeeId, mobile } = scenario;

    await deleteEmployee(form(employeeId));

    const outcome = await withTenant(tenantId, (tx) =>
      handleInbound(scenario.context(tx), typeText(mobile, 'I was at the client site')),
    );
    expect(outcome).toEqual({ handled: false, reason: 'unknown_sender' });
  });

  it('takes them off the dashboard and out of the employee list', async () => {
    await setup();
    const { tenantId, employeeId } = scenario;

    await deleteEmployee(form(employeeId));

    expect(await flaggedInRange(tenantId, ASKED, UNSENT)).toHaveLength(0);
    expect(await listEmployees(tenantId)).toHaveLength(0);
  });

  it('removes the row outright when the open cases are deleted too', async () => {
    await setup();
    const { tenantId, employeeId } = scenario;

    await deleteEmployee(form(employeeId, true));

    const left = await remaining(tenantId, employeeId);
    expect(left.employee, 'nothing is left to keep them for').toBeFalsy();
    expect(left.cases).toHaveLength(0);
    expect(left.days).toHaveLength(0);
    expect(redirects[0]).not.toContain('kept=');
  });

  it('removes the row outright when there was nothing worth keeping', async () => {
    await setup();
    const { tenantId, employeeId } = scenario;
    // Close the only case with a conversation behind it: now every case of
    // theirs is finished or unsent, so keeping the row would record nothing.
    await withTenant(tenantId, (tx) =>
      tx.update(cases).set({ status: 'resolved' }).where(and(eq(cases.employeeId, employeeId), eq(cases.attDate, ASKED))),
    );

    await deleteEmployee(form(employeeId));

    const left = await remaining(tenantId, employeeId);
    expect(left.employee).toBeFalsy();
    expect(left.cases).toHaveLength(0);
  });
});

describe('the daily check', () => {
  it('opens no case for a deleted employee, however their attendance arrives', async () => {
    await setup();
    const { tenantId, employeeId, channel } = scenario;
    // The keeping option, so the row is still there to be found at all.
    await deleteEmployee(form(employeeId));

    // Their absence comes back on the next import; nobody is there to ask.
    const date = '2026-08-13';
    await withTenant(tenantId, async (tx) => {
      await giveAttendance(tx, tenantId, employeeId, [{ date, meaning: 'absent_full' }]);
      const result = await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
      expect(result.gapsFound).toBe(0);
      expect(result.casesCreated).toBe(0);
    });
    expect(channel.history()).toHaveLength(0);
  });
});

/**
 * The way back. An attendance file is the record of who works here, so somebody
 * in it works here - deleted or not - and the cases that were kept when they
 * went are work again rather than a record.
 */
describe('re-importing a deleted employee', () => {
  const MONTH = '2026-09';
  const CASE_DATE = '2026-09-02';

  /** A profile the generated workbook fits, and the file itself. */
  async function importable(tenantId: string) {
    const preset = presetByKey('single_code_row_per_day');
    await withTenant(tenantId, async (tx) => {
      const [profile] = await tx
        .insert(mappingProfiles)
        .values({ tenantId, name: preset.label, status: 'active', fieldMap: preset.fieldMap, activatedAt: new Date() })
        .returning();
      await tx.insert(codeMappings).values(
        preset.codes.map((code) => ({
          tenantId,
          profileId: profile!.id,
          code: code.code.toUpperCase(),
          meaning: code.meaning,
          chase: code.chase ?? null,
          confirmedAt: new Date(),
        })),
      );
    });
    const [person] = generatePeople(1, 7, 'RE-');
    return { file: buildRowPerDayWorkbook([person!], MONTH, 5, 7), code: person!.code };
  }

  it('brings them back, and their kept case with them', async () => {
    scenario = await makeScenario();
    activeTenantId = scenario.tenantId;
    const { tenantId, channel } = scenario;
    const { file, code } = await importable(tenantId);

    const employeeId = await withTenant(tenantId, async (tx) => {
      await importAttendanceFile(tx, tenantId, file, { source: 'upload', filename: 'september.xlsx' });
      const person = await tx.query.employees.findFirst({ where: eq(employees.empCode, code) });
      await tx
        .insert(cases)
        .values({
          tenantId,
          employeeId: person!.id,
          attDate: CASE_DATE,
          meaning: 'absent_full',
          status: 'asked',
          askedAt: new Date(),
        });
      return person!.id;
    });

    await deleteEmployee(form(employeeId));
    const deleted = await remaining(tenantId, employeeId);
    expect(deleted.employee?.deletedAt, 'deleted, but kept for the case').toBeTruthy();
    expect(deleted.cases).toHaveLength(1);

    // The same file again: the deletion is lifted rather than a stranger hired.
    const report = await withTenant(tenantId, async (tx) => {
      const result = await importAttendanceFile(tx, tenantId, file, { source: 'upload', filename: 'september.xlsx' });
      return result.report;
    });
    expect(report.employeesRestored).toBe(1);
    expect(report.employeesCreated, 'the same person, not a new one').toBe(0);

    const back = await remaining(tenantId, employeeId);
    expect(back.employee?.deletedAt).toBeNull();
    expect(back.cases.map((c) => c.attDate), 'the case that was kept is still theirs').toEqual([CASE_DATE]);
    expect(back.days.length, 'their attendance is back too').toBeGreaterThan(0);

    // And the case is work again: the button that refused now sends.
    const outcome = await withTenant(tenantId, (tx) => contactCaseById(scenario.context(tx), back.cases[0]!.id));
    expect(outcome?.contacted).toBe(true);
    expect(channel.history()).toHaveLength(1);
    // Listed again beside the scenario's own employee, rather than hidden.
    expect((await listEmployees(tenantId)).map((e) => e.empCode)).toContain(code);
  });
});
