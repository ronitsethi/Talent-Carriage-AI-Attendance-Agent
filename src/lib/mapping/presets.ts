import type { FieldMap } from '@/db/schema/mapping';
import type { Meaning } from './meanings';

export type CodePreset = { code: string; meaning: Meaning; chase?: boolean | null };

export type MappingPreset = {
  key: string;
  label: string;
  hrmsHint: string;
  description: string;
  fieldMap: FieldMap;
  codes: CodePreset[];
};

/** Codes almost every Indian HRMS uses, whatever its layout. */
const COMMON_CODES: CodePreset[] = [
  { code: 'P', meaning: 'present' },
  { code: 'A', meaning: 'absent_full' },
  { code: 'WO', meaning: 'weekly_off' },
  { code: 'HO', meaning: 'holiday' },
  { code: 'H', meaning: 'holiday' },
  { code: 'CL', meaning: 'leave_approved' },
  { code: 'SL', meaning: 'leave_approved' },
  { code: 'EL', meaning: 'leave_approved' },
  { code: 'PL', meaning: 'leave_approved' },
  { code: 'LWP', meaning: 'leave_unpaid' },
  { code: 'LOP', meaning: 'leave_unpaid' },
  { code: 'MP', meaning: 'missed_punch' },
  { code: 'OD', meaning: 'on_duty' },
  { code: 'WFH', meaning: 'work_from_home' },
  { code: 'TR', meaning: 'training' },
  { code: 'CO', meaning: 'comp_off' },
  { code: 'HD', meaning: 'absent_half_unspecified' },
];

/**
 * Starting points for onboarding. A new customer's profile is cloned from the
 * closest preset and adjusted in the mapping studio, which is what turns a
 * two-week onboarding into a review rather than a build.
 */
export const MAPPING_PRESETS: MappingPreset[] = [
  {
    key: 'timeoffice_two_session',
    label: 'TimeOffice register (two sessions per day)',
    hrmsHint: 'TimeOffice',
    description:
      'One column per day headed "1 / 8 | Sat", each cell holding both halves of the day as "P|A". The year comes from the report run date.',
    fieldMap: {
      fields: {
        employee_code: { columns: ['Employee Code'], transform: ['trim'] },
        employee_name: { columns: ['Full name'], transform: ['collapse_spaces'] },
        mobile: { columns: ['Mobile number'], transform: ['phone_india'] },
        department: { columns: ['Department'], transform: ['trim'] },
        branch: { columns: ['Branch'], transform: ['trim'] },
        location: { columns: ['Sub branch'], transform: ['trim'] },
        manager_ref: { columns: ['Reporting manager'], transform: ['collapse_spaces'] },
        date_of_joining: { columns: ['Date of joining'] },
        employment_status: { columns: ['Employment status'], transform: ['trim'] },
      },
      dateLayout: {
        kind: 'column_per_day',
        headerPattern: String.raw`^\s*(?<day>\d{1,2})\s*/\s*(?<month>\d{1,2})\s*\|`,
        yearFrom: 'filter_sheet',
      },
      statusLayout: { kind: 'two_session', separator: '|' },
      sheetHint: 'attendance',
    },
    codes: COMMON_CODES,
  },
  {
    key: 'single_code_row_per_day',
    label: 'One row per employee per day (single status code)',
    hrmsHint: 'Generic HRMS export',
    description:
      'A long-format export: each row is one employee on one date, with a single code such as Ab, CL or SL, and the name split across two columns.',
    fieldMap: {
      fields: {
        employee_code: { columns: ['EmpID'], transform: ['trim'] },
        employee_name: { columns: ['First Name', 'Last Name'], join: ' ', transform: ['collapse_spaces'] },
        mobile: { columns: ['Contact'], transform: ['phone_india'] },
        department: { columns: ['Dept'], transform: ['trim'] },
        manager_ref: { columns: ['Manager Emp ID'], transform: ['trim'] },
        attendance_status: { columns: ['Status'], transform: ['upper', 'trim'] },
      },
      dateLayout: { kind: 'row_per_day', column: 'Date' },
      statusLayout: { kind: 'single' },
    },
    codes: [
      ...COMMON_CODES,
      { code: 'AB', meaning: 'absent_full' },
      { code: 'ABS', meaning: 'absent_full' },
      { code: 'PR', meaning: 'present' },
    ],
  },
  {
    key: 'numeric_day_columns',
    label: 'Numeric day columns (1 / 0.5 / 0)',
    hrmsHint: 'Spreadsheet muster',
    description:
      'A spreadsheet muster where each day column holds a day fraction: 1 present, 0.5 half day, 0 absent, with letters for offs.',
    fieldMap: {
      fields: {
        employee_code: { columns: ['Emp Code'], transform: ['trim'] },
        employee_name: { columns: ['Emp Name'], transform: ['collapse_spaces'] },
        mobile: { columns: ['Phone'], transform: ['phone_india'] },
        department: { columns: ['Function'], transform: ['trim'] },
        manager_ref: { columns: ['Supervisor'], transform: ['collapse_spaces'] },
      },
      dateLayout: {
        kind: 'column_per_day',
        headerPattern: String.raw`^(?<day>\d{1,2})-(?<month>\d{1,2})-(?<year>\d{4})$`,
        yearFrom: 'fixed',
      },
      statusLayout: { kind: 'single' },
    },
    codes: [
      { code: '1', meaning: 'present' },
      { code: '1.0', meaning: 'present' },
      { code: '0.5', meaning: 'absent_half_unspecified' },
      { code: '0', meaning: 'absent_full' },
      { code: 'W', meaning: 'weekly_off' },
      { code: 'H', meaning: 'holiday' },
      { code: 'L', meaning: 'leave_approved' },
      { code: 'U', meaning: 'leave_unpaid' },
    ],
  },
  {
    key: 'punch_times',
    label: 'In and out punch times only',
    hrmsHint: 'Biometric device export',
    description:
      'No status codes at all: each row has the first in-punch and last out-punch, and the meaning is derived from them.',
    fieldMap: {
      fields: {
        employee_code: { columns: ['Card No'], transform: ['trim'] },
        employee_name: { columns: ['Name'], transform: ['collapse_spaces'] },
        mobile: { columns: ['Mobile'], transform: ['phone_india'] },
      },
      dateLayout: { kind: 'row_per_day', column: 'Punch Date' },
      statusLayout: { kind: 'punch_times', inColumn: 'In Time', outColumn: 'Out Time' },
    },
    codes: [],
  },
];

export function presetByKey(key: string): MappingPreset {
  const preset = MAPPING_PRESETS.find((p) => p.key === key);
  if (!preset) throw new Error(`Unknown mapping preset: ${key}`);
  return preset;
}

export function presetCodeLookup(preset: MappingPreset) {
  return new Map(
    preset.codes.map((c) => [c.code.toUpperCase(), { meaning: c.meaning, chase: c.chase ?? null }] as const),
  );
}
