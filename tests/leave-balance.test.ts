import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { leaveBalanceUploads, leaveBalances } from '@/db/schema';
import {
  detectLeaveFields,
  importLeaveBalances,
  leaveBalanceSummary,
  leaveTable,
  missingLeaveFields,
  resolveLeaveMap,
} from '@/lib/leave-balance';
import { companyRefusal } from '@/lib/company';
import { ground } from '@/lib/conversation/talk';
import { makeScenario, type Scenario } from './helpers/scenario';

/**
 * The leave balance upload: found by its headings, one row per employee per
 * leave type, replacing each listed employee's balances, and read to the
 * employee it belongs to. Every value here is made up.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const HEADINGS = [
  'Employee Code', 'Full name', 'Employment status', 'Company', 'Department', 'Leave type', 'Leave balance',
  'Leave balance considering pending leave', 'Leave name', 'Pending leave',
];

function file(rows: unknown[][], company = 'Test Company Private Limited') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([HEADINGS, ...rows.map((row) => [row[0], row[1], 'Confirmed', company, 'Sales', ...row.slice(2)])]), 'Leave_Balance');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Filter', 'Value'], ['Employment status', 'Confirmed']]), 'Filters');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Ankit (E-1) has 10.5 PL with 2 pending, and 3 CL; somebody unknown too. */
const SAMPLE = [
  ['E-1', 'Ankit Panwar', 'PL', 10.5, 8.5, 'Privilege Leave', 2],
  ['E-1', 'Ankit Panwar', 'CL', 3, 3, 'Casual Leave', ''],
  ['Z-99', 'Nobody Here', 'PL', 4, 4, 'Privilege Leave', ''],
];

const MAP = {
  employeeCode: 'Employee Code',
  leaveType: 'Leave type',
  balance: 'Leave balance',
  balanceAfterPending: 'Leave balance considering pending leave',
  leaveName: 'Leave name',
  pending: 'Pending leave',
};

async function upload(buffer: Buffer) {
  return withTenant(scenario.tenantId, async (tx) => {
    const table = leaveTable(buffer);
    const fits = resolveLeaveMap(MAP, table.columns);
    if (!('map' in fits)) throw new Error('mapping does not fit');
    const [row] = await tx.insert(leaveBalanceUploads).values({ tenantId: scenario.tenantId, filename: 'leave.xlsx' }).returning();
    return importLeaveBalances(tx, scenario.tenantId, row!.id, table, fits.map);
  });
}

describe('reading a leave balance file', () => {
  it('finds each column by its heading, telling the balance from the one after pending leave', () => {
    const table = leaveTable(file(SAMPLE));
    expect(table.sheetName).toBe('Leave_Balance');
    const map = detectLeaveFields(table.columns);
    expect(map).toEqual(MAP);
    expect(missingLeaveFields(map)).toEqual([]);
    expect(missingLeaveFields({ employeeCode: 'Employee Code' })).toEqual(['Leave type (code)', 'Leave balance']);
  });

  it('reads a file however its headings are capitalised, and says which mapped column is missing', () => {
    const table = leaveTable(file(SAMPLE));
    expect(resolveLeaveMap({ ...MAP, leaveType: 'LEAVE TYPE' }, table.columns)).toEqual({ map: MAP });
    expect(resolveLeaveMap({ ...MAP, balance: 'Closing balance' }, table.columns)).toEqual({ missing: ['"Closing balance" (leave balance)'] });
  });

  it('is refused for another company', () => {
    const table = leaveTable(file(SAMPLE, 'Some Other Company Pvt Ltd'));
    expect(companyRefusal(table, 'Test Company', 'leave.xlsx', 'leave balance')).toContain('leave.xlsx is leave balance for Some Other Company Pvt Ltd, not Test Company');
    expect(companyRefusal(leaveTable(file(SAMPLE)), 'Test Company', 'leave.xlsx', 'leave balance')).toBeNull();
  });
});

describe('uploading leave balances', () => {
  it('keeps half days and pending leave, and reports codes that are not employees', async () => {
    scenario = await makeScenario();
    const report = await upload(file(SAMPLE));
    expect(report).toMatchObject({ rows: 3, employees: 1, balances: 2, unmatched: ['Z-99'], skipped: 0, leaveTypes: ['CL', 'PL'] });

    const rows = await withTenant(scenario.tenantId, (tx) => tx.select().from(leaveBalances).where(eq(leaveBalances.employeeId, scenario.employeeId)));
    const pl = rows.find((r) => r.leaveType === 'PL');
    expect(pl).toMatchObject({ balanceDays: 10.5, pendingDays: 2, balanceAfterPending: 8.5, leaveName: 'Privilege Leave', source: 'upload' });
  });

  it('replaces an employee’s balances with the newest file, dropping a type it no longer lists', async () => {
    scenario = await makeScenario();
    await upload(file(SAMPLE));
    await upload(file([['E-1', 'Ankit Panwar', 'PL', 9.5, 9.5, 'Privilege Leave', '']]));
    const rows = await withTenant(scenario.tenantId, (tx) => tx.select().from(leaveBalances).where(eq(leaveBalances.employeeId, scenario.employeeId)));
    expect(rows.map((r) => [r.leaveType, r.balanceDays])).toEqual([['PL', 9.5]]);
  });

  it('is read to the employee it belongs to, next to their attendance', async () => {
    scenario = await makeScenario();
    await upload(file(SAMPLE));
    const summary = await withTenant(scenario.tenantId, (tx) => leaveBalanceSummary(tx, scenario.tenantId, scenario.employeeId));
    expect(summary).toMatch(/^Leave balance as on \d{1,2} [A-Z][a-z]+ \d{4}, by leave type:/);
    expect(summary).toContain('Casual Leave (CL): 3 days left.');
    expect(summary).toContain('Privilege Leave (PL): 10.5 days left; 2 days applied and pending approval, leaving 8.5 days once approved.');

    const grounding = await withTenant(scenario.tenantId, (tx) => ground(tx, scenario.tenantId, scenario.employeeId, ''));
    expect(grounding.leave).toBe(summary);
    expect(grounding.attendance).toBeTruthy();
  });

  it('gives the agent nothing when no balance has been uploaded', async () => {
    scenario = await makeScenario();
    expect(await withTenant(scenario.tenantId, (tx) => leaveBalanceSummary(tx, scenario.tenantId, scenario.employeeId))).toBe('');
  });
});
