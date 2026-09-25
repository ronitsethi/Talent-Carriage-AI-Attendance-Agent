import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { applyProfile } from '@/lib/mapping/apply';
import { combineSessions, shouldChase } from '@/lib/mapping/meanings';
import { presetByKey, presetCodeLookup } from '@/lib/mapping/presets';
import { detectRunDate, pickTable, readWorkbook } from '@/lib/mapping/source';
import { normaliseIndianMobile } from '@/lib/mapping/transforms';

const DEMO_FILE = path.join(process.cwd(), 'demo', 'DEMO_Attendance_data_v1.0.xlsx');

/** Builds an in-memory workbook, so each layout is tested against a real file. */
function workbook(sheets: Record<string, Record<string, unknown>[]>) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }
  return readWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

function run(wb: ReturnType<typeof workbook>, presetKey: string) {
  const preset = presetByKey(presetKey);
  const table = pickTable(wb, preset.fieldMap.sheetHint ?? null);
  return applyProfile(table, preset.fieldMap, presetCodeLookup(preset), { runDate: detectRunDate(wb) });
}

describe('mobile normalisation', () => {
  it('accepts the shapes customers actually send', () => {
    expect(normaliseIndianMobile('9686770749')).toBe('919686770749');
    expect(normaliseIndianMobile('09686770749')).toBe('919686770749');
    expect(normaliseIndianMobile('+91 96867-70749')).toBe('919686770749');
    expect(normaliseIndianMobile('919686770749')).toBe('919686770749');
    expect(normaliseIndianMobile('')).toBeNull();
  });
});

describe('two-session combination', () => {
  it('reads each half of the day', () => {
    expect(combineSessions('present', 'present')).toBe('present');
    expect(combineSessions('absent_full', 'absent_full')).toBe('absent_full');
    expect(combineSessions('absent_full', 'present')).toBe('absent_first_half');
    expect(combineSessions('present', 'absent_full')).toBe('absent_second_half');
  });

  it('does not let a benign half hide a real gap', () => {
    expect(combineSessions('weekly_off', 'absent_full')).toBe('absent_second_half');
    expect(combineSessions('leave_approved', 'missed_punch')).toBe('missed_punch');
    expect(combineSessions('weekly_off', 'present')).toBe('present');
  });
});

describe('chase rules', () => {
  it('always chases absences and never chases offs or unknown codes', () => {
    expect(shouldChase('absent_full')).toBe(true);
    expect(shouldChase('absent_second_half')).toBe(true);
    expect(shouldChase('weekly_off')).toBe(false);
    expect(shouldChase('holiday')).toBe(false);
    expect(shouldChase('leave_approved')).toBe(false);
    // An unmapped code must stay silent whatever the configuration says.
    expect(shouldChase('unknown', { codeOverride: true })).toBe(false);
  });

  it('treats optional meanings as opt-in per tenant', () => {
    expect(shouldChase('late_in')).toBe(false);
    expect(shouldChase('late_in', { tenantChaseMeanings: ['late_in'] })).toBe(true);
    expect(shouldChase('leave_unpaid', { tenantChaseMeanings: ['leave_unpaid'] })).toBe(true);
  });
});

describe('TimeOffice register (the real demo file)', () => {
  const wb = readWorkbook(fs.readFileSync(DEMO_FILE));
  const result = run(wb, 'timeoffice_two_session');

  it('finds the year from the report run date', () => {
    expect(detectRunDate(wb)).toEqual({ month: 9, year: 2026 });
    expect(result.dayColumns[0]?.date).toBe('2026-08-01');
    expect(result.dayColumns.at(-1)?.date).toBe('2026-08-31');
  });

  it('maps every employee and every day, with nothing unmapped', () => {
    expect(result.records).toHaveLength(12);
    expect(result.rejected).toHaveLength(0);
    expect(result.unmapped).toEqual({});
    expect(result.records.every((r) => r.days.length === 31)).toBe(true);
  });

  it('reads half-days as the correct half', () => {
    const ankit = result.records.find((r) => r.employee.fullName === 'Ankit Panwar')!;
    const day = (date: string) => ankit.days.find((d) => d.date === date)!;
    expect(day('2026-08-17')).toMatchObject({ rawStatus: 'P|A', meaning: 'absent_second_half' });
    expect(day('2026-08-18')).toMatchObject({ rawStatus: 'A|A', meaning: 'absent_full' });
    expect(day('2026-08-19')).toMatchObject({ rawStatus: 'P|A', meaning: 'absent_second_half' });
    expect(day('2026-08-20')).toMatchObject({ rawStatus: 'A|P', meaning: 'absent_first_half' });
    expect(day('2026-08-01')).toMatchObject({ rawStatus: 'WO|WO', meaning: 'weekly_off' });
    expect(day('2026-08-15')).toMatchObject({ rawStatus: 'HO|HO', meaning: 'holiday' });
  });

  it('carries the details needed to message and escalate', () => {
    const ankit = result.records.find((r) => r.employee.fullName === 'Ankit Panwar')!;
    expect(ankit.employee).toMatchObject({
      empCode: '10000014',
      mobileE164: '917042097645',
      department: 'Operations',
      managerRef: 'Uday Moitra',
    });
  });
});

describe('a completely different shape: one row per day, single codes, split names', () => {
  const wb = workbook({
    Attendance: [
      { EmpID: 'E-1', 'First Name': 'Meera', 'Last Name': 'Nair', Contact: '09876543210', Dept: 'Sales', 'Manager Emp ID': 'E-9', Date: '18-08-2026', Status: 'Ab' },
      { EmpID: 'E-1', 'First Name': 'Meera', 'Last Name': 'Nair', Contact: '09876543210', Dept: 'Sales', 'Manager Emp ID': 'E-9', Date: '19-08-2026', Status: 'CL' },
      { EmpID: 'E-1', 'First Name': 'Meera', 'Last Name': 'Nair', Contact: '09876543210', Dept: 'Sales', 'Manager Emp ID': 'E-9', Date: '20-08-2026', Status: 'HD' },
      { EmpID: 'E-9', 'First Name': 'Rahul', 'Last Name': 'Verma', Contact: '9812345678', Dept: 'Sales', 'Manager Emp ID': '', Date: '18-08-2026', Status: 'PR' },
      { EmpID: 'E-9', 'First Name': 'Rahul', 'Last Name': 'Verma', Contact: '9812345678', Dept: 'Sales', 'Manager Emp ID': '', Date: '19-08-2026', Status: 'ZZ' },
    ],
  });
  const result = run(wb, 'single_code_row_per_day');

  it('groups the rows back into employees', () => {
    expect(result.records).toHaveLength(2);
    const meera = result.records.find((r) => r.employee.empCode === 'E-1')!;
    expect(meera.employee.fullName).toBe('Meera Nair');
    expect(meera.employee.mobileE164).toBe('919876543210');
    expect(meera.days).toHaveLength(3);
  });

  it('maps single codes, including a half day', () => {
    const meera = result.records.find((r) => r.employee.empCode === 'E-1')!;
    expect(meera.days.map((d) => d.meaning)).toEqual(['absent_full', 'leave_approved', 'absent_half_unspecified']);
  });

  it('reports an unknown code instead of guessing at it', () => {
    const rahul = result.records.find((r) => r.employee.empCode === 'E-9')!;
    const unknownDay = rahul.days.find((d) => d.rawStatus === 'ZZ')!;
    expect(unknownDay.meaning).toBe('unknown');
    expect(result.unmapped).toEqual({ ZZ: 1 });
    expect(shouldChase(unknownDay.meaning)).toBe(false);
  });
});

describe('a third shape: numeric day fractions', () => {
  const result = run(
    workbook({
      Muster: [
        { 'Emp Code': '7001', 'Emp Name': 'Sana Khan', Phone: '9700000001', Function: 'Ops', Supervisor: 'Sana Lead', '17-08-2026': '1', '18-08-2026': '0', '19-08-2026': '0.5', '20-08-2026': 'W' },
      ],
    }),
    'numeric_day_columns',
  );

  it('treats 0 as absent and 0.5 as a half day', () => {
    const days = result.records[0]!.days;
    expect(days.map((d) => [d.date, d.meaning])).toEqual([
      ['2026-08-17', 'present'],
      ['2026-08-18', 'absent_full'],
      ['2026-08-19', 'absent_half_unspecified'],
      ['2026-08-20', 'weekly_off'],
    ]);
  });
});

describe('a fourth shape: punch times with no codes at all', () => {
  const result = run(
    workbook({
      Punches: [
        { 'Card No': 'C-1', Name: 'Iqbal Shaikh', Mobile: '9700000002', 'Punch Date': '2026-08-18', 'In Time': '09:41', 'Out Time': '18:10' },
        { 'Card No': 'C-1', Name: 'Iqbal Shaikh', Mobile: '9700000002', 'Punch Date': '2026-08-19', 'In Time': '09:45', 'Out Time': '' },
        { 'Card No': 'C-1', Name: 'Iqbal Shaikh', Mobile: '9700000002', 'Punch Date': '2026-08-20', 'In Time': '', 'Out Time': '' },
      ],
    }),
    'punch_times',
  );

  it('derives presence, a missed punch and an absence from the times', () => {
    expect(result.records[0]!.days.map((d) => d.meaning)).toEqual(['present', 'missed_punch', 'absent_full']);
  });
});

describe('rejections', () => {
  it('rejects rows it cannot identify rather than inventing an employee', () => {
    const result = run(
      workbook({
        Attendance: [
          { EmpID: '', 'First Name': 'No', 'Last Name': 'Code', Contact: '9700000003', Date: '18-08-2026', Status: 'Ab' },
          { EmpID: 'E-5', 'First Name': 'Bad', 'Last Name': 'Date', Contact: '9700000004', Date: 'not a date', Status: 'Ab' },
        ],
      }),
      'single_code_row_per_day',
    );
    expect(result.rejected).toEqual([
      { row: 2, reason: 'No employee code' },
      { row: 3, employeeCode: 'E-5', reason: 'Unreadable date' },
    ]);
  });
});
