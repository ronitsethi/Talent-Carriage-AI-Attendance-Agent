import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { analyseFile, buildFieldMap } from '@/lib/mapping/analyse';
import { applyProfile } from '@/lib/mapping/apply';
import { pickTable, readWorkbook } from '@/lib/mapping/source';

/**
 * Setting a customer up from their own file.
 *
 * The mapping was previously written by a developer, in code. These tests cover
 * the path a person takes instead: upload the file, read back what it found,
 * correct it, and have the importer honour the result.
 */

function workbook(rows: Record<string, unknown>[], sheet = 'Attendance'): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('reading a file nobody has mapped yet', () => {
  it('finds the employee columns by their headings', () => {
    const file = workbook([
      { 'Emp ID': 'E1', 'First Name': 'Aryan', 'Last Name': 'Jain', 'Mobile No': '9718290560', Dept: 'Ops', Date: '2026-09-21', Status: 'A' },
    ]);
    const analysis = analyseFile(file);

    expect(analysis.fields.employee_code).toEqual(['Emp ID']);
    expect(analysis.fields.mobile).toEqual(['Mobile No']);
    expect(analysis.fields.department).toEqual(['Dept']);
    // A name split over two columns is kept as two, joined on save.
    expect(analysis.fields.employee_name).toEqual(['First Name', 'Last Name']);
  });

  it('tells a row-per-day file from a column-per-day one', () => {
    const rowPerDay = analyseFile(
      workbook([{ 'Emp ID': 'E1', Name: 'A', Mobile: '9718290560', Date: '2026-09-21', Status: 'A' }]),
    );
    expect(rowPerDay.layout).toBe('row_per_day');

    const columnPerDay = analyseFile(
      workbook([
        { 'Emp Code': 'E1', 'Full name': 'A', Mobile: '9718290560', '1 / 9': 'P', '2 / 9': 'A', '3 / 9': 'P', '4 / 9': 'WO', '5 / 9': 'P', '6 / 9': 'P' },
      ]),
    );
    expect(columnPerDay.layout).toBe('column_per_day');
    expect(columnPerDay.dayColumns).toHaveLength(6);
  });

  it('lists every code with a count, commonest first', () => {
    const analysis = analyseFile(
      workbook([
        { 'Emp ID': 'E1', Name: 'A', Mobile: '9718290560', '1 / 9': 'P', '2 / 9': 'P', '3 / 9': 'A', '4 / 9': 'P', '5 / 9': 'WO', '6 / 9': 'XQ' },
      ]),
    );

    expect(analysis.codes[0]!.code).toBe('P');
    expect(analysis.codes[0]!.count).toBe(3);
    expect(analysis.codes.map((c) => c.code).sort()).toEqual(['A', 'P', 'WO', 'XQ']);
  });

  it('guesses the obvious codes and refuses to guess the rest', () => {
    const analysis = analyseFile(
      workbook([
        { 'Emp ID': 'E1', Name: 'A', Mobile: '9718290560', '1 / 9': 'A', '2 / 9': 'WO', '3 / 9': 'ZZ', '4 / 9': 'P', '5 / 9': 'P', '6 / 9': 'P' },
      ]),
    );
    const byCode = Object.fromEntries(analysis.codes.map((c) => [c.code, c]));

    expect(byCode.A!.guess).toBe('absent_full');
    expect(byCode.WO!.guess).toBe('weekly_off');
    // A code it cannot place must default to something that is never chased.
    expect(byCode.ZZ!.guess).toBe('unknown');
    expect(byCode.ZZ!.confident).toBe(false);
  });

  it('spots two sessions packed into one cell', () => {
    const analysis = analyseFile(
      workbook([
        { 'Emp ID': 'E1', Name: 'A', Mobile: '9718290560', '1 / 9': 'P|P', '2 / 9': 'A|P', '3 / 9': 'P|A', '4 / 9': 'A|A', '5 / 9': 'P|P', '6 / 9': 'P|P' },
      ]),
    );

    expect(analysis.separator).toBe('|');
    // The halves are what need a meaning, not the pairs.
    expect(analysis.codes.map((c) => c.code).sort()).toEqual(['A', 'P']);
  });
});

describe('the mapping a person saves', () => {
  it('is honoured by the importer', () => {
    const file = workbook([
      { 'Staff No': 'E1', 'Full name': 'Aryan Jain', Cell: '9718290560', '1 / 9': 'A', '2 / 9': 'P', '3 / 9': 'A', '4 / 9': 'P', '5 / 9': 'P', '6 / 9': 'P' },
    ]);
    const analysis = analyseFile(file);

    // As if the screen had been corrected by hand: "Staff No" and "Cell" are not
    // headings the guesser knows.
    const fieldMap = buildFieldMap({
      sheetName: analysis.sheetName,
      fields: { employee_code: ['Staff No'], employee_name: ['Full name'], mobile: ['Cell'] },
      layout: 'column_per_day',
      year: 2026,
      separator: null,
    });

    const codes = new Map([
      ['A', { meaning: 'absent_full' as const, chase: null }],
      ['P', { meaning: 'present' as const, chase: null }],
    ]);
    const result = applyProfile(pickTable(readWorkbook(file)), fieldMap, codes);

    expect(result.records).toHaveLength(1);
    const employee = result.records[0]!.employee;
    expect(employee.empCode).toBe('E1');
    expect(employee.fullName).toBe('Aryan Jain');
    expect(employee.mobileE164).toBe('919718290560');

    const absent = result.records[0]!.days.filter((d) => d.meaning === 'absent_full');
    expect(absent.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-03']);
    expect(result.unmapped).toEqual({});
  });

  it('records a code left unexplained rather than inventing a meaning', () => {
    const file = workbook([
      { 'Emp ID': 'E1', 'Full name': 'A', Mobile: '9718290560', '1 / 9': 'A', '2 / 9': 'QQ', '3 / 9': 'P', '4 / 9': 'P', '5 / 9': 'P', '6 / 9': 'P' },
    ]);
    const fieldMap = buildFieldMap({
      sheetName: 'Attendance',
      fields: { employee_code: ['Emp ID'], employee_name: ['Full name'], mobile: ['Mobile'] },
      layout: 'column_per_day',
      year: 2026,
      separator: null,
    });

    const result = applyProfile(
      pickTable(readWorkbook(file)),
      fieldMap,
      new Map([['A', { meaning: 'absent_full' as const, chase: null }]]),
    );
    const unexplained = result.records[0]!.days.find((d) => d.rawStatus === 'QQ');

    expect(unexplained!.meaning, 'never chased').toBe('unknown');
    expect(result.unmapped.QQ).toBe(1);
  });
});

describe('a bare "Status" column', () => {
  it('is read as the attendance, not as employment status', () => {
    // The real shape of a one-row-per-day export: the codes live in "Status",
    // and reading it as anything else leaves the file with no codes to map.
    const analysis = analyseFile(
      workbook([
        { EmpID: 'DI-1001', 'First Name': 'Aryan', 'Last Name': 'Jain', Contact: '9718290560', Dept: 'Operations', Date: '01-09-2026', Status: 'Ab' },
        { EmpID: 'DI-1001', 'First Name': 'Aryan', 'Last Name': 'Jain', Contact: '9718290560', Dept: 'Operations', Date: '02-09-2026', Status: 'P' },
      ]),
    );

    expect(analysis.fields.attendance_status).toEqual(['Status']);
    expect(analysis.fields.employment_status).toBeUndefined();
    expect(analysis.codes.map((c) => c.code).sort()).toEqual(['Ab', 'P']);
  });
});

describe('a file that lists the same employee twice', () => {
  it('keeps one day per date rather than breaking the whole import', () => {
    // A register split by department, a repeated header block, or two months
    // pasted into one sheet. Postgres rejects a batch holding the same
    // (employee, date) twice, with an error that says nothing about the file.
    const file = workbook([
      { 'Emp ID': 'E1', 'Full name': 'Aryan', Mobile: '9718290560', '1 / 9': 'P', '2 / 9': 'A', '3 / 9': 'P', '4 / 9': 'P', '5 / 9': 'P', '6 / 9': 'P' },
      { 'Emp ID': 'E1', 'Full name': 'Aryan', Mobile: '9718290560', '1 / 9': 'P', '2 / 9': 'WO', '3 / 9': 'P', '4 / 9': 'P', '5 / 9': 'P', '6 / 9': 'P' },
    ]);
    const fieldMap = buildFieldMap({
      sheetName: 'Attendance',
      fields: { employee_code: ['Emp ID'], employee_name: ['Full name'], mobile: ['Mobile'] },
      layout: 'column_per_day',
      year: 2026,
      separator: null,
    });

    const result = applyProfile(
      pickTable(readWorkbook(file)),
      fieldMap,
      new Map([
        ['P', { meaning: 'present' as const, chase: null }],
        ['A', { meaning: 'absent_full' as const, chase: null }],
        ['WO', { meaning: 'weekly_off' as const, chase: null }],
      ]),
    );

    expect(result.records).toHaveLength(1);
    const days = result.records[0]!.days;
    expect(days).toHaveLength(6);
    expect(new Set(days.map((d) => d.date)).size, 'one row per date').toBe(6);
    // The later row wins, as it does for the employee's own details.
    expect(days.find((d) => d.date === '2026-09-02')!.meaning).toBe('weekly_off');
  });
});
