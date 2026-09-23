import * as XLSX from 'xlsx';
import { pool } from './db.js';

// Day columns look like "1 / 8 | Sat" (day / month | weekday).
const DAY_COL_RE = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\|/;

export function normalizeMobile(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Parses the TimeOffice "Attendance register" export into employees + day-wise sessions.
export function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  // The Filters sheet carries the report run date (e.g. 18-09-2026); the month itself comes from the column headers.
  let runYear = new Date().getFullYear();
  let runMonth = 12;
  const filterName = wb.SheetNames.find((n) => /filter/i.test(n));
  if (filterName) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[filterName], { header: 1 });
    const m = /(\d{2})-(\d{2})-(\d{4})/.exec(JSON.stringify(rows));
    if (m) { runMonth = +m[2]; runYear = +m[3]; }
  }

  const sheetName = wb.SheetNames.find((n) => /attendance/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null, raw: false });
  if (!rows.length) throw new Error(`Sheet "${sheetName}" is empty`);

  const dayCols = [];
  for (const col of Object.keys(rows[0])) {
    const m = DAY_COL_RE.exec(col);
    if (!m) continue;
    const day = +m[1];
    const month = +m[2];
    // A December register run in January belongs to the previous year.
    const year = month > runMonth ? runYear - 1 : runYear;
    dayCols.push({ col, date: iso(year, month, day) });
  }
  if (!dayCols.length) throw new Error('No day columns like "1 / 8 | Sat" found');

  const employees = [];
  for (const row of rows) {
    const name = row['Full name'];
    const code = row['Employee Code'];
    if (!name || !code) continue;
    const days = [];
    for (const { col, date } of dayCols) {
      const raw = row[col];
      if (!raw) continue;
      const parts = String(raw).split('|').map((s) => s.trim().toUpperCase());
      days.push({ date, first: parts[0] || null, second: parts[1] ?? parts[0] ?? null, raw: String(raw) });
    }
    employees.push({
      emp_code: String(code).trim(),
      full_name: String(name).trim(),
      department: row['Department'] || null,
      branch: row['Branch'] || null,
      manager: row['Reporting manager'] || null,
      mobile: row['Mobile number'] ? String(row['Mobile number']).trim() : null,
      days,
    });
  }
  return { sheetName, employees, dates: dayCols.map((d) => d.date) };
}

export async function importWorkbook(buffer) {
  const parsed = parseWorkbook(buffer);
  const client = await pool.connect();
  let attendanceRows = 0;
  try {
    await client.query('BEGIN');
    for (const e of parsed.employees) {
      const { rows } = await client.query(
        `INSERT INTO employees (emp_code, full_name, department, branch, manager, mobile, mobile_e164)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (emp_code) DO UPDATE SET
           full_name = EXCLUDED.full_name, department = EXCLUDED.department, branch = EXCLUDED.branch,
           manager = EXCLUDED.manager, mobile = EXCLUDED.mobile, mobile_e164 = EXCLUDED.mobile_e164, updated_at = now()
         RETURNING id`,
        [e.emp_code, e.full_name, e.department, e.branch, e.manager, e.mobile, normalizeMobile(e.mobile)],
      );
      const employeeId = rows[0].id;
      for (const d of e.days) {
        await client.query(
          `INSERT INTO attendance (employee_id, att_date, first_half, second_half, raw)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (employee_id, att_date) DO UPDATE SET
             first_half = EXCLUDED.first_half, second_half = EXCLUDED.second_half, raw = EXCLUDED.raw`,
          [employeeId, d.date, d.first, d.second, d.raw],
        );
        attendanceRows++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const dates = parsed.dates.sort();
  return {
    sheet: parsed.sheetName,
    employees: parsed.employees.length,
    attendanceRows,
    from: dates[0],
    to: dates[dates.length - 1],
  };
}
