import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyseFile, buildFieldMap } from '@/lib/mapping/analyse';
import { applyProfile } from '@/lib/mapping/apply';
import { detectRunDate, pickTable, readWorkbook } from '@/lib/mapping/source';

/**
 * A real TimeOffice register, as a customer actually exports it.
 *
 * 63 columns: a dozen employee properties, 31 day columns headed "1 / 8 | Sat",
 * then a run of monthly totals. The totals are the trap - read one as a day and
 * the month grows a thirty-second date; read one as the attendance status and
 * the codes are numbers.
 */

const FILE = '/Users/work/Downloads/TimeOffice_Attendance_register_form_25 (10).xlsx';
let file: Buffer;
try {
  file = readFileSync(FILE);
} catch {
  file = Buffer.alloc(0);
}
const run = file.length ? describe : describe.skip;

run('a TimeOffice register', () => {
  it('picks the register sheet over the filters sheet', () => {
    const analysis = analyseFile(file);
    expect(analysis.sheetName).toBe('Attendance register form 25');
    expect(analysis.sheetNames).toContain('Filters');
  });

  it('finds the 31 day columns and leaves the totals alone', () => {
    const analysis = analyseFile(file);

    expect(analysis.layout).toBe('column_per_day');
    expect(analysis.dayColumns).toHaveLength(31);
    expect(analysis.dayColumns[0]).toBe('1 / 8 | Sat');
    expect(analysis.dayColumns[30]).toBe('31 / 8 | Mon');

    // The columns after the dates are monthly totals, not days.
    for (const total of ['Expected Work Days', 'Present', 'Absent', 'Pay days', 'Total']) {
      expect(analysis.dayColumns, `${total} is a total`).not.toContain(total);
    }
  });

  it('reads the year out of the report footer', () => {
    // "Report was run at 25-09-2026" - the register is for August, so 2026.
    expect(analyseFile(file).year).toBe(2026);
    expect(detectRunDate(readWorkbook(file))).toEqual({ month: 9, year: 2026 });
  });

  it('sees two sessions packed into each cell', () => {
    const analysis = analyseFile(file);
    expect(analysis.separator).toBe('|');
    // The halves are what carry a meaning, so "P|P" is not offered as a code.
    expect(analysis.codes.map((c) => c.code)).not.toContain('P|P');
    expect(analysis.codes.map((c) => c.code)).toContain('P');
  });

  it('matches the employee columns without help', () => {
    const analysis = analyseFile(file);
    expect(analysis.fields.employee_code).toEqual(['Employee Code']);
    expect(analysis.fields.employee_name).toEqual(['Full name']);
    expect(analysis.fields.department).toEqual(['Department']);
    expect(analysis.fields.date_of_joining).toEqual(['Date of joining']);
    // This export carries no phone number, which is allowed - the column is
    // simply left unmatched rather than guessed at.
    expect(analysis.fields.mobile).toBeUndefined();

    // "Present" here is a monthly total. Reading it as the day's status would
    // make every code a number, and the register has no status column at all.
    expect(analysis.fields.attendance_status).toBeUndefined();
  });

  it('reads the register once a person has supplied the missing phone column', () => {
    const analysis = analyseFile(file);
    const fieldMap = buildFieldMap({
      sheetName: analysis.sheetName,
      // As the screen would submit it: the guesses, plus Card No standing in
      // for the phone column this particular export lacks.
      fields: { ...analysis.fields, mobile: ['Card No'] },
      layout: 'column_per_day',
      year: analysis.year,
      separator: analysis.separator,
    });

    const codes = new Map([
      ['P', { meaning: 'present' as const, chase: null }],
      ['A', { meaning: 'absent_full' as const, chase: null }],
      ['WO', { meaning: 'weekly_off' as const, chase: null }],
      ['CL', { meaning: 'leave_approved' as const, chase: null }],
    ]);

    const wb = readWorkbook(file);
    const result = applyProfile(pickTable(wb, analysis.sheetName), fieldMap, codes, { runDate: detectRunDate(wb) });

    expect(result.records.length).toBeGreaterThan(20);
    const first = result.records[0]!;
    expect(first.employee.empCode).toBe('10460001');
    expect(first.employee.fullName).toBe('Narayan Tukaram Hapase');
    expect(first.days).toHaveLength(31);
    expect(first.days[0]!.date).toBe('2026-08-01');
    expect(first.days[30]!.date).toBe('2026-08-31');
  });
});
