import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { attendanceDays, codeMappings, employees, imports, mappingProfiles } from '@/db/schema';
import { importAttendanceFile } from '@/lib/mapping/import';
import { presetByKey } from '@/lib/mapping/presets';
import { buildRowPerDayWorkbook, generatePeople } from '@/db/seed/generate';
import { makeScenario, type Scenario } from './helpers/scenario';

/**
 * Today's attendance is not final until the day is over. A file that runs up to
 * today is still taken - nothing is rejected - but only up to yesterday.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

async function profileFor(tenantId: string) {
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
}

describe("an upload that includes today's attendance", () => {
  it('imports every day before today and leaves today, and anything after it, out', async () => {
    scenario = await makeScenario();
    const { tenantId } = scenario;
    await profileFor(tenantId);
    const [person] = generatePeople(1, 11, 'TD-');
    // 1st to 5th of September, uploaded on the 5th.
    const file = buildRowPerDayWorkbook([person!], '2026-09', 5, 11);

    const result = await withTenant(tenantId, (tx) =>
      importAttendanceFile(tx, tenantId, file, { source: 'upload', filename: 'september.xlsx', today: '2026-09-05' }),
    );
    expect(result.report.daysImported).toBe(4);
    expect(result.report.daysHeldBack).toBe(1);
    expect(result.dateTo).toBe('2026-09-04');
    expect(Object.values(result.report.meaningCounts).reduce((a, b) => a + b, 0)).toBe(4);

    const days = await withTenant(tenantId, async (tx) => {
      const employee = await tx.query.employees.findFirst({ where: eq(employees.empCode, person!.code) });
      return tx.select({ date: attendanceDays.attDate }).from(attendanceDays).where(eq(attendanceDays.employeeId, employee!.id));
    });
    expect(days.map((d) => d.date).sort()).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(imports).where(eq(imports.id, result.importId!)));
    expect(row).toMatchObject({ status: 'completed', dateTo: '2026-09-04' });
  });

  it("is not rejected when it holds nothing but today: the employees are read, no day is written", async () => {
    scenario = await makeScenario();
    const { tenantId } = scenario;
    await profileFor(tenantId);
    const [person] = generatePeople(1, 12, 'TE-');
    const file = buildRowPerDayWorkbook([person!], '2026-09', 3, 12);

    const result = await withTenant(tenantId, (tx) =>
      importAttendanceFile(tx, tenantId, file, { source: 'upload', filename: 'early.xlsx', today: '2026-09-01' }),
    );
    expect(result.report).toMatchObject({ employeesSeen: 1, daysImported: 0, daysHeldBack: 3 });
    expect(result.dateFrom).toBeUndefined();
  });
});
