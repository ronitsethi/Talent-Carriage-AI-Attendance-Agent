import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { codeMappings, mappingProfiles, tenantSettings, tenants } from '@/db/schema';
import { companyColumn, companyRefusal, sameCompany } from '@/lib/company';
import { importAttendanceFile } from '@/lib/mapping/import';
import { presetByKey } from '@/lib/mapping/presets';
import { buildRowPerDayWorkbook, generatePeople } from '@/db/seed/generate';
import { makeScenario, type Scenario } from './helpers/scenario';

/** A customer's files go in only when their company column names the company on Mapping, Company tab. */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const DPOD = { column: 'Company', name: 'Dpod Lifestyle Private Limited' };

describe('whose file it is', () => {
  it('finds the mapped company column by its heading, ignoring case and spacing', () => {
    expect(companyColumn(['Employee Code', ' company ', 'Business Unit'], 'Company')).toBe(' company ');
    expect(companyColumn(['EmpID', 'Business Unit'], 'Company')).toBeNull();
    // Only the mapped heading counts, not any company-like one.
    expect(companyColumn(['Employer', 'Legal Entity'], 'Legal entity')).toBe('Legal Entity');
  });

  it('matches the mapped company name however the legal form is written', () => {
    expect(sameCompany('Dpod Lifestyle Pvt. Ltd.', 'Dpod Lifestyle Private Limited')).toBe(true);
    expect(sameCompany('DPOD LIFESTYLE', 'Dpod Lifestyle Private Limited')).toBe(true);
    expect(sameCompany('Dpod Lifestyle Private Limited', 'Demo Industries')).toBe(false);
    // A shorter or longer name is another company.
    expect(sameCompany('Northwind Retail', 'Northwind')).toBe(false);
    expect(sameCompany('Demo Logistics Pvt Ltd', 'Demo Industries')).toBe(false);
  });

  it('says which company a file is for when it is not the mapped one', () => {
    const table = { columns: ['Company'], rows: [{ Company: 'Dpod Lifestyle Pvt Ltd' }, { Company: '' }] };
    expect(companyRefusal(table, DPOD, 'oct.xlsx', 'payroll')).toBeNull();
    expect(companyRefusal(table, { column: 'Company', name: 'Demo Industries' }, 'oct.xlsx', 'payroll')).toBe(
      'oct.xlsx is payroll for Dpod Lifestyle Pvt Ltd, not Demo Industries. Check the file, or the company name on Mapping, Company tab.',
    );
    // Not set up, or no such column in the file: nothing to check against.
    expect(companyRefusal(table, null, 'oct.xlsx', 'payroll')).toBeNull();
    expect(companyRefusal({ columns: ['EmpID'], rows: [{ EmpID: '1' }] }, DPOD, 'a.xlsx', 'attendance')).toBeNull();
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

  const importAs = (company: string, filename: string) =>
    withTenant(scenario.tenantId, (tx) => importAttendanceFile(tx, scenario.tenantId, registerFor(company), { source: 'upload', filename, today: '2026-10-10' }));

  it('takes any company until the company mapping is saved', async () => {
    await customer('Demo Industries');
    expect((await importAs('Acme Widgets Private Limited', 'acme.xlsx')).report.daysImported).toBe(3);
  });

  it('checks the register against the mapped company name, not the customer name', async () => {
    await customer('Demo Industries');
    await withTenant(scenario.tenantId, (tx) =>
      tx.update(tenantSettings).set({ companyColumn: 'company', companyName: 'Acme Widgets Pvt Ltd' }).where(eq(tenantSettings.tenantId, scenario.tenantId)),
    );
    // The customer's own name in the portal no longer lets a file in.
    await expect(importAs('Demo Industries', 'demo.xlsx')).rejects.toThrow('demo.xlsx is attendance for Demo Industries, not Acme Widgets Pvt Ltd.');
    expect((await importAs('Acme Widgets Private Limited', 'acme.xlsx')).report.daysImported).toBe(3);
  });
});
