import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { codeMappings, mappingProfiles, tenants } from '@/db/schema';
import { companyColumn, companyRefusal, sameCompany } from '@/lib/company';
import { importAttendanceFile } from '@/lib/mapping/import';
import { presetByKey } from '@/lib/mapping/presets';
import { buildRowPerDayWorkbook, generatePeople } from '@/db/seed/generate';
import { makeScenario, type Scenario } from './helpers/scenario';

/** A customer's attendance and payroll files go only into that customer. */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

describe('whose file it is', () => {
  it('finds the company column by its heading', () => {
    expect(companyColumn(['Employee Code', ' Company ', 'Business Unit'])).toBe(' Company ');
    expect(companyColumn(['EmpID', 'Business Unit'])).toBeNull();
  });

  it('matches a customer to the legal name in its files', () => {
    expect(sameCompany('Dpod Lifestyle Private Limited', 'DPOD Lifestyle')).toBe(true);
    expect(sameCompany('Talent Carriage Management Pvt. Ltd.', 'Talent Carriage Management')).toBe(true);
    expect(sameCompany('Northwind Retail', 'Northwind')).toBe(true);
    expect(sameCompany('Dpod Lifestyle Private Limited', 'Demo Industries')).toBe(false);
    expect(sameCompany('Dpod Lifestyle Private Limited', 'Test1')).toBe(false);
    // A shared word is not the same company.
    expect(sameCompany('Demo Logistics Pvt Ltd', 'Demo Industries')).toBe(false);
  });

  it('says which company a file is for when it is not this one', () => {
    const table = { columns: ['Company'], rows: [{ Company: 'Dpod Lifestyle Private Limited' }, { Company: '' }] };
    expect(companyRefusal(table, 'DPOD Lifestyle', 'oct.xlsx', 'payroll')).toBeNull();
    expect(companyRefusal(table, 'Demo Industries', 'oct.xlsx', 'payroll')).toBe(
      "oct.xlsx is payroll for Dpod Lifestyle Private Limited, not Demo Industries. Switch to that customer under Viewing customer, or upload this customer's own file.",
    );
    // No company column: nothing to check against.
    expect(companyRefusal({ columns: ['EmpID'], rows: [{ EmpID: '1' }] }, 'Demo Industries', 'a.xlsx', 'attendance')).toBeNull();
  });
});

describe('importing attendance', () => {
  /** A register with a Company column naming `company` on every row. */
  function registerFor(company: string) {
    const [person] = generatePeople(1, 21, 'CO-');
    const book = XLSX.read(buildRowPerDayWorkbook([person!], '2026-09', 3, 21), { type: 'buffer' });
    const sheet = book.Sheets[book.SheetNames[0]!]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet).map((row) => ({ ...row, Company: company }));
    book.Sheets[book.SheetNames[0]!] = XLSX.utils.json_to_sheet(rows);
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  async function customer(name: string) {
    scenario = await makeScenario();
    await withPlatformScope((tx) => tx.update(tenants).set({ name }).where(eq(tenants.id, scenario.tenantId)));
    const preset = presetByKey('single_code_row_per_day');
    await withTenant(scenario.tenantId, async (tx) => {
      const [profile] = await tx
        .insert(mappingProfiles)
        .values({ tenantId: scenario.tenantId, name: preset.label, status: 'active', fieldMap: preset.fieldMap, activatedAt: new Date() })
        .returning();
      await tx.insert(codeMappings).values(
        preset.codes.map((code) => ({ tenantId: scenario.tenantId, profileId: profile!.id, code: code.code.toUpperCase(), meaning: code.meaning, chase: code.chase ?? null, confirmedAt: new Date() })),
      );
    });
  }

  it("refuses another company's register, and takes the customer's own", async () => {
    await customer('Demo Industries');
    await expect(
      withTenant(scenario.tenantId, (tx) =>
        importAttendanceFile(tx, scenario.tenantId, registerFor('Dpod Lifestyle Private Limited'), { source: 'upload', filename: 'dpod.xlsx', today: '2026-10-10' }),
      ),
    ).rejects.toThrow('dpod.xlsx is attendance for Dpod Lifestyle Private Limited, not Demo Industries.');

    const own = await withTenant(scenario.tenantId, (tx) =>
      importAttendanceFile(tx, scenario.tenantId, registerFor('Demo Industries Pvt Ltd'), { source: 'upload', filename: 'demo.xlsx', today: '2026-10-10' }),
    );
    expect(own.report.daysImported).toBe(3);
  });
});
