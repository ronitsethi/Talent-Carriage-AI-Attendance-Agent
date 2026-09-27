import * as XLSX from 'xlsx';

/**
 * Synthetic attendance files, one per layout the platform supports.
 *
 * Seeded randomness, so every run produces the same data and a screenshot taken
 * today matches one taken next week.
 */

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Vihaan', 'Ananya', 'Arjun', 'Ishita', 'Kabir', 'Meera', 'Rohan', 'Sana',
  'Yash', 'Nisha', 'Imran', 'Pooja', 'Farhan', 'Kavya', 'Devansh', 'Ritu', 'Manav', 'Sneha',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Nair', 'Reddy', 'Iyer', 'Khan', 'Verma', 'Joshi', 'Das', 'Mehta',
];
const DEPARTMENTS = ['Operations', 'Sales', 'Warehouse', 'Support', 'Finance'];
const LOCATIONS = ['Ahmedabad', 'Pune', 'Noida', 'Bangalore'];

export type GeneratedPerson = {
  code: string;
  name: string;
  firstName: string;
  lastName: string;
  mobile: string;
  department: string;
  location: string;
  managerCode: string | null;
};

export function generatePeople(count: number, seed: number, codePrefix: string): GeneratedPerson[] {
  const random = mulberry32(seed);
  const people: GeneratedPerson[] = [];

  for (let i = 0; i < count; i++) {
    const firstName = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]!;
    const lastName = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]!;
    // Test numbers only: 999xxxxxxx is not a live Indian mobile range in use here.
    const mobile = `9990${String(100000 + Math.floor(random() * 899999)).slice(0, 6)}`;
    people.push({
      code: `${codePrefix}${1000 + i}`,
      name: `${firstName} ${lastName}`,
      firstName,
      lastName,
      mobile,
      department: DEPARTMENTS[Math.floor(random() * DEPARTMENTS.length)]!,
      location: LOCATIONS[Math.floor(random() * LOCATIONS.length)]!,
      managerCode: i < 2 ? null : `${codePrefix}${1000 + (i % 2)}`,
    });
  }
  return people;
}

function eachDay(month: string, days: number) {
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

const isWeekend = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

/**
 * Picks a day's status. Most people are present; a few have absences, half days
 * and missed punches, and one or two have a long run of absent days so the
 * backlog behaviour is visible in the demo.
 */
function statusFor(person: GeneratedPerson, iso: string, index: number, random: () => number) {
  if (isWeekend(iso)) return 'weekly_off';
  const roll = random();
  const longAbsence = index === 3 && Number(iso.slice(-2)) >= 17 && Number(iso.slice(-2)) <= 21;
  if (longAbsence) return 'absent_full';
  if (roll > 0.94) return 'absent_full';
  if (roll > 0.9) return 'absent_half';
  if (roll > 0.87) return 'missed_punch';
  if (roll > 0.84) return 'leave_approved';
  return 'present';
}

/** Long format: one row per employee per day, single codes, split names. */
export function buildRowPerDayWorkbook(people: GeneratedPerson[], month: string, days: number, seed: number): Buffer {
  const random = mulberry32(seed);
  const rows: Record<string, string>[] = [];

  people.forEach((person, index) => {
    for (const iso of eachDay(month, days)) {
      const status = statusFor(person, iso, index, random);
      const code =
        status === 'present'
          ? 'PR'
          : status === 'absent_full'
            ? 'Ab'
            : status === 'absent_half'
              ? 'HD'
              : status === 'missed_punch'
                ? 'MP'
                : status === 'leave_approved'
                  ? 'CL'
                  : 'WO';
      const [y, m, d] = iso.split('-');
      rows.push({
        EmpID: person.code,
        'First Name': person.firstName,
        'Last Name': person.lastName,
        Contact: `0${person.mobile}`,
        Dept: person.department,
        'Manager Emp ID': person.managerCode ?? '',
        Date: `${d}-${m}-${y}`,
        Status: code,
      });
    }
  });

  return sheetToBuffer({ Attendance: rows });
}

/** Wide format: a column per day holding a day fraction. */
export function buildNumericWorkbook(people: GeneratedPerson[], month: string, days: number, seed: number): Buffer {
  const random = mulberry32(seed);
  const rows = people.map((person, index) => {
    const row: Record<string, string> = {
      'Emp Code': person.code,
      'Emp Name': person.name,
      Phone: person.mobile,
      Function: person.department,
      Supervisor: person.managerCode ?? '',
    };
    for (const iso of eachDay(month, days)) {
      const status = statusFor(person, iso, index, random);
      const [y, m, d] = iso.split('-');
      row[`${d}-${m}-${y}`] =
        status === 'present' ? '1' : status === 'absent_full' ? '0' : status === 'absent_half' ? '0.5' : status === 'weekly_off' ? 'W' : status === 'leave_approved' ? 'L' : '0';
    }
    return row;
  });

  return sheetToBuffer({ Muster: rows });
}

function sheetToBuffer(sheets: Record<string, Record<string, string>[]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
