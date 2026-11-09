import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { codeMappings, leaveBalanceUploads, mappingProfiles, unmappedCodes } from '@/db/schema';
import { importLeaveBalances, leaveBalanceSummary, leaveTable, resolveLeaveMap } from '@/lib/leave-balance';
import { leaveTaken, leaveTakenLines, type CodeBook } from '@/lib/leave-types';
import { attendanceSummary } from '@/lib/knowledge';
import { presetByKey } from '@/lib/mapping/presets';
import type { Meaning } from '@/lib/mapping/meanings';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * Kinds of leave: one code table explains PL, CL, SL wherever they appear, so
 * leave taken in the attendance and the leave balance line up type by type,
 * with or without a leave name in the balance file. Every value here is made up.
 */

const CODES: [string, Meaning][] = [
  ['P', 'present'],
  ['A', 'absent_full'],
  ['PL', 'leave_earned'],
  ['EL', 'leave_earned'],
  ['CL', 'leave_casual'],
  ['L', 'leave_approved'],
];
const book: CodeBook = { codes: new Map(CODES), separator: '|' };

describe('leave taken per type', () => {
  it('counts a half of a split cell as half a day, and puts two codes for the same leave together', () => {
    const taken = leaveTaken(
      [
        { date: '2026-10-05', rawStatus: 'PL', meaning: 'leave_earned' },
        { date: '2026-10-06', rawStatus: 'PL|P', meaning: 'leave_earned' },
        { date: '2026-10-07', rawStatus: 'A|EL', meaning: 'absent_first_half' },
        { date: '2026-10-08', rawStatus: 'CL|CL', meaning: 'leave_casual' },
        { date: '2026-10-09', rawStatus: 'L', meaning: 'leave_approved' },
        { date: '2026-10-10', rawStatus: 'P', meaning: 'present' },
      ],
      book,
    );
    const by = Object.fromEntries(taken.map((t) => [t.kind, { codes: [...t.codes].sort(), days: t.days, dates: t.dates }]));
    expect(by).toEqual({
      leave_earned: { codes: ['EL', 'PL'], days: 2, dates: ['5', '6 (first half)', '7 (second half)'] },
      leave_casual: { codes: ['CL'], days: 1, dates: ['8'] },
      leave_approved: { codes: ['L'], days: 1, dates: ['9'] },
    });
  });

  it('counts a day whose code is no longer in the table by the meaning it was imported with', () => {
    const taken = leaveTaken([{ date: '2026-10-05', rawStatus: 'XL', meaning: 'leave_sick' }], book);
    expect(taken.map((t) => [t.kind, t.days])).toEqual([['leave_sick', 1]]);
  });

  it('is written out month by month, naming each kind', () => {
    const lines = leaveTakenLines(
      [
        { date: '2026-09-30', rawStatus: 'CL', meaning: 'leave_casual' },
        { date: '2026-10-06', rawStatus: 'PL|P', meaning: 'leave_earned' },
        { date: '2026-10-09', rawStatus: 'L', meaning: 'leave_approved' },
      ],
      book,
    );
    expect(lines).toEqual([
      'Leave taken by type, from the attendance (a half day counts half; use this for leave taken per type):',
      '  September 2026:',
      '    Casual leave (CL): 1 day — on the 30',
      '  October 2026:',
      '    Earned / privilege leave (PL): 0.5 days — on the 6 (first half)',
      '    Leave, type not given (L): 1 day — on the 9',
    ]);
  });
});

describe('the leave balance and the attendance, side by side', () => {
  let scenario: Scenario;
  afterEach(async () => {
    await scenario?.cleanup();
  });

  async function customerWithCodes() {
    scenario = await makeScenario();
    const preset = presetByKey('timeoffice_two_session');
    await withTenant(scenario.tenantId, async (tx) => {
      const [profile] = await tx
        .insert(mappingProfiles)
        .values({ tenantId: scenario.tenantId, name: preset.label, status: 'active', fieldMap: preset.fieldMap, activatedAt: new Date() })
        .returning();
      await tx.insert(codeMappings).values(CODES.map(([code, meaning]) => ({ tenantId: scenario.tenantId, profileId: profile!.id, code, meaning, confirmedAt: new Date() })));
    });
  }

  /** A balance file with no leave name column: PL, CL, an unknown ML, and L with no kind. */
  function balances() {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['Employee Code', 'Leave type', 'Leave balance'],
        ['E-1', 'PL', 10.5],
        ['E-1', 'CL', 3],
        ['E-1', 'ML', 2],
        ['E-1', 'L', 1],
      ]),
      'Sheet1',
    );
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  it('names each balance by its kind from the code table, and flags the codes it cannot name', async () => {
    await customerWithCodes();
    const report = await withTenant(scenario.tenantId, async (tx) => {
      const table = leaveTable(balances());
      const fits = resolveLeaveMap({ employeeCode: 'Employee Code', leaveType: 'Leave type', balance: 'Leave balance' }, table.columns);
      if (!('map' in fits)) throw new Error('mapping does not fit');
      const [upload] = await tx.insert(leaveBalanceUploads).values({ tenantId: scenario.tenantId }).returning();
      return importLeaveBalances(tx, scenario.tenantId, upload!.id, table, fits.map);
    });
    expect(report).toMatchObject({ employees: 1, balances: 4, unexplained: ['ML'], untyped: ['L'] });

    const [flagged] = await withTenant(scenario.tenantId, (tx) =>
      tx.select().from(unmappedCodes).where(and(eq(unmappedCodes.tenantId, scenario.tenantId), eq(unmappedCodes.code, 'ML'))),
    );
    expect(flagged?.resolvedAt).toBeNull();

    const summary = await withTenant(scenario.tenantId, (tx) => leaveBalanceSummary(tx, scenario.tenantId, scenario.employeeId));
    expect(summary).toContain('Earned / privilege leave (PL): 10.5 days left.');
    expect(summary).toContain('Casual leave (CL): 3 days left.');
    expect(summary).toContain('ML: 2 days left.');
    expect(summary).toContain('L: 1 day left.');
  });

  it('tells leave taken per type in the attendance, and not again as whole days', async () => {
    await customerWithCodes();
    await withTenant(scenario.tenantId, (tx) =>
      giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-10-05', meaning: 'leave_earned', raw: 'PL' },
        { date: '2026-10-06', meaning: 'leave_earned', raw: 'PL|P' },
        { date: '2026-10-07', meaning: 'absent_full', raw: 'A' },
        { date: '2026-10-08', meaning: 'present', raw: 'P' },
      ]),
    );
    const summary = await withTenant(scenario.tenantId, (tx) => attendanceSummary(tx, scenario.tenantId, scenario.employeeId));
    expect(summary).toContain('Earned / privilege leave (PL): 1.5 days — on the 5, 6 (first half)');
    expect(summary).toContain('Absent (full day): 1 day — on the 7');
    expect(summary).not.toMatch(/Earned \/ privilege leave: 2 days/);
  });
});
