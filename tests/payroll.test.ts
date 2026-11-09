import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { payrollRows, payrollUploads } from '@/db/schema';
import { lockMonth } from '@/lib/locks';
import {
  attendanceWorkbook,
  defaultExcluded,
  detectFields,
  importPayroll,
  missingRequired,
  monthInFile,
  payrollRefusal,
  payrollSummary,
  payrollTable,
  payrollWorkbook,
  removePayroll,
  resolveExcluded,
  resolveMap,
} from '@/lib/payroll';
import { ground } from '@/lib/conversation/talk';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * The payroll upload: found by its headings, kept without identity or bank
 * details, checked against the locked attendance, and read to the employee
 * whose row it is.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const HEADINGS = [
  'Serial No.', 'Employee Code', 'Full name', 'PAN', 'Salary month', 'Salary year', 'Calendar days', 'Paid days',
  'Basic(R)', 'Basic', 'Monthly rate', 'Gross salary', ' Gross arrear', 'PF', ' Gross deduction', ' Net take home',
  'Salary account number', 'Salary IFSC code', ' Total employee cost',
];
/** A register like the customer's: Ankit (E-1) paid 28.5 of 31 days of ₹25,000; somebody unknown too. */
function register(month = 10, rows?: unknown[][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      HEADINGS,
      ...(rows ?? [
        [1, 'E-1', 'Ankit Panwar', 'ABCDE1234F', month, 2026, 31, 28.5, 14165, 13023, 25000, 22984, 0, 1977, 1977, 21007, '00000000000', 'TEST0000000', 24960],
        [2, 'X-9', 'Nobody Here', 'PANNOTAVBL', month, 2026, 31, 31, 10000, 10000, 15000, 15000, 0, 0, 0, 15000, '1234', 'HDFC0000001', 16000],
      ]),
    ]),
    'Sheet1',
  );
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Filter', 'Value'], ['Month/Year', 'Last Month']]), 'Filters');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('reading a payroll file', () => {
  it('finds the key columns by their headings, and leaves identity and bank details out', () => {
    const table = payrollTable(register());
    expect(table.sheetName).toBe('Sheet1');
    const map = detectFields(table.columns);
    expect(map).toEqual({
      employeeCode: 'Employee Code',
      calendarDays: 'Calendar days',
      paidDays: 'Paid days',
      rate: 'Monthly rate',
      gross: 'Gross salary',
      deductions: 'Gross deduction',
      net: 'Net take home',
      arrears: 'Gross arrear',
    });
    expect(missingRequired(map)).toEqual([]);
    expect(defaultExcluded(table.columns)).toEqual(['Serial No.', 'PAN', 'Salary account number', 'Salary IFSC code', 'Total employee cost']);
    expect(monthInFile(table)).toBe('2026-10');
  });
});

describe('the saved payroll mapping', () => {
  const saved = {
    employeeCode: 'employee code',
    calendarDays: 'Calendar Days',
    paidDays: 'Paid days',
    gross: 'Gross salary',
    net: 'Net take home',
    rate: 'Monthly rate',
  };

  it('reads a file however its headings are spaced or capitalised', () => {
    const table = payrollTable(register());
    const fits = resolveMap(saved, table.columns);
    expect(fits).toEqual({ map: { employeeCode: 'Employee Code', calendarDays: 'Calendar days', paidDays: 'Paid days', gross: 'Gross salary', net: 'Net take home', rate: 'Monthly rate' } });
    expect(resolveExcluded(['serial no.', 'Total Employee Cost'], table.columns)).toEqual(['Serial No.', 'Total employee cost']);
  });

  it('says which mapped columns a file does not have', () => {
    const table = payrollTable(register());
    expect(resolveMap({ ...saved, net: 'Net pay' }, table.columns)).toEqual({ missing: ['"Net pay" (net pay (take home))'] });
  });
});

describe('importing a month', () => {
  async function lockedOctober() {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      // Two absent days and a half day: 28.5 of 31 paid, as the payroll says.
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-10-06', meaning: 'absent_full' },
        { date: '2026-10-07', meaning: 'absent_full' },
        { date: '2026-10-15', meaning: 'absent_first_half' },
        { date: '2026-10-16', meaning: 'present' },
      ]);
    });
  }

  async function upload(file = register()) {
    return withTenant(scenario.tenantId, async (tx) => {
      const table = payrollTable(file);
      const [row] = await tx.insert(payrollUploads).values({ tenantId: scenario.tenantId, month: '2026-10', columns: table.columns }).returning();
      const map = detectFields(table.columns) as Parameters<typeof importPayroll>[5];
      return importPayroll(tx, scenario.tenantId, row!.id, '2026-10', table, map, defaultExcluded(table.columns));
    });
  }

  it('is refused until the month is locked, and once uploaded', async () => {
    await lockedOctober();
    expect(await withTenant(scenario.tenantId, (tx) => payrollRefusal(tx, scenario.tenantId, '2026-10'))).toContain('not locked');
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, '2026-10', null));
    expect(await withTenant(scenario.tenantId, (tx) => payrollRefusal(tx, scenario.tenantId, '2026-10'))).toBeNull();
    await upload();
    expect(await withTenant(scenario.tenantId, (tx) => payrollRefusal(tx, scenario.tenantId, '2026-10'))).toContain('already been uploaded');
  });

  it('can be unlocked, which removes it and its rows, and then uploaded again', async () => {
    await lockedOctober();
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, '2026-10', null));
    await upload();
    expect(await withTenant(scenario.tenantId, (tx) => removePayroll(tx, scenario.tenantId, '2026-10'))).toBe(true);
    expect(await withTenant(scenario.tenantId, (tx) => tx.select().from(payrollRows).where(eq(payrollRows.tenantId, scenario.tenantId)))).toEqual([]);
    expect(await withTenant(scenario.tenantId, (tx) => payrollSummary(tx, scenario.tenantId, scenario.employeeId))).not.toContain('October 2026');
    expect(await withTenant(scenario.tenantId, (tx) => payrollRefusal(tx, scenario.tenantId, '2026-10'))).toBeNull();
    expect(await withTenant(scenario.tenantId, (tx) => removePayroll(tx, scenario.tenantId, '2026-10'))).toBe(false);
    expect(await upload()).toMatchObject({ matched: 1 });
  });

  it('matches by code, keeps no identity or bank details, and agrees with the locked attendance', async () => {
    await lockedOctober();
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, '2026-10', null));
    const report = await upload();
    expect(report).toMatchObject({ rows: 2, matched: 1, unmatched: ['X-9'], warnings: [] });
    expect(report.dropped).toEqual(expect.arrayContaining(['PAN', 'Salary account number', 'Salary IFSC code']));

    const [row] = await withTenant(scenario.tenantId, (tx) => tx.select().from(payrollRows).where(eq(payrollRows.employeeId, scenario.employeeId)));
    expect(row).toMatchObject({ month: '2026-10', empCode: 'E-1', calendarDays: 31, paidDays: 28.5, monthlyRate: 25000, gross: 22984, net: 21007 });
    const headings = row!.fields.map(([heading]) => heading);
    expect(headings).toContain('PF');
    expect(headings).not.toContain('PAN');
    expect(JSON.stringify(row!.fields)).not.toContain('00000000000');
  });

  it('flags a row whose paid days do not agree with the attendance, or whose gross is not the rate for them', async () => {
    await lockedOctober();
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, '2026-10', null));
    const report = await upload(
      register(10, [[1, 'E-1', 'Ankit Panwar', 'ABCDE1234F', 10, 2026, 31, 30, 14165, 13023, 25000, 22984, 0, 1977, 1977, 21007, '1', 'X', 1]]),
    );
    expect(report.warnings.map((w) => w.text)).toEqual([
      'Gross salary 22984 is not the monthly rate for the paid days (24194).',
      'Paid days are 30, but the locked attendance shows 2.5 unpaid days (28.5 paid).',
    ]);
  });

  it('is read to the employee it belongs to, with the days not paid to explain it', async () => {
    await lockedOctober();
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, '2026-10', null));
    await upload();
    const summary = await withTenant(scenario.tenantId, (tx) => payrollSummary(tx, scenario.tenantId, scenario.employeeId));
    expect(summary).toContain('October 2026: days in the month 31, paid days 28.5, full monthly salary ₹25,000, gross earned ₹22,984');
    expect(summary).toContain('net pay ₹21,007');
    expect(summary).toContain('PF: 1977');
    expect(summary).not.toContain('ABCDE1234F');

    const grounding = await withTenant(scenario.tenantId, (tx) => ground(tx, scenario.tenantId, scenario.employeeId, ''));
    expect(grounding.payroll).toBe(summary);
    expect(grounding.attendance).toContain('Absent (full day): 2 days');
  });

  it('downloads the final attendance as a register, and the payroll without what was not kept', async () => {
    await lockedOctober();
    await withTenant(scenario.tenantId, (tx) => lockMonth(tx, scenario.tenantId, '2026-10', null));
    await upload();
    const attendance = await withTenant(scenario.tenantId, (tx) => attendanceWorkbook(tx, scenario.tenantId, '2026-10'));
    const sheet = XLSX.read(attendance, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet.Sheets[sheet.SheetNames[0]!]!, { header: 1 });
    expect(rows[0]).toEqual(expect.arrayContaining(['Employee code', 'Name', '1', '31', 'Unpaid days']));
    expect(rows[1]!.at(-1)).toBe(2.5);

    const payroll = await withTenant(scenario.tenantId, (tx) => payrollWorkbook(tx, scenario.tenantId, '2026-10'));
    const book = XLSX.read(payroll!, { type: 'buffer' });
    const header = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!]!, { header: 1 })[0] as string[];
    expect(header).toContain('Net take home');
    expect(header).not.toContain('PAN');
    expect(header).not.toContain('Salary IFSC code');
  });
});
