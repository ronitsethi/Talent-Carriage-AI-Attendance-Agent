import * as XLSX from 'xlsx';

export type SourceTable = {
  sheetName: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

export type SourceWorkbook = {
  tables: SourceTable[];
  /** Everything as text, used to find a report run date wherever it hides. */
  rawText: string;
};

/** Reads .xlsx, .xls or .csv into plain rows, with values kept as strings. */
export function readWorkbook(buffer: Buffer | Uint8Array): SourceWorkbook {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const tables: SourceTable[] = [];
  const textParts: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
    const columns = rows.length ? Object.keys(rows[0]!) : [];
    tables.push({ sheetName, columns, rows });
    textParts.push(XLSX.utils.sheet_to_csv(sheet));
  }

  return { tables, rawText: textParts.join('\n') };
}

/**
 * Picks the sheet holding attendance. A hint from the mapping profile wins, then
 * a sheet whose name mentions attendance, then simply the widest sheet — which
 * is the register in every export seen so far.
 */
export function pickTable(wb: SourceWorkbook, hint?: string | null): SourceTable {
  if (!wb.tables.length) throw new Error('The file has no readable sheets');
  if (hint) {
    const hinted = wb.tables.find((t) => t.sheetName.toLowerCase().includes(hint.toLowerCase()));
    if (hinted?.rows.length) return hinted;
  }
  const named = wb.tables.find((t) => /attendance|register|muster/i.test(t.sheetName) && t.rows.length);
  if (named) return named;
  return [...wb.tables].sort((a, b) => b.columns.length - a.columns.length)[0]!;
}

/**
 * Finds the report run date (e.g. "Report was run at 18-09-2026 18:18 IST"),
 * which is how a register with "1 / 8" columns and no year tells us the year.
 */
export function detectRunDate(wb: SourceWorkbook): { month: number; year: number } | null {
  const match = /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(wb.rawText);
  if (!match) return null;
  return { month: Number(match[2]), year: Number(match[3]) };
}

/** Distinct non-empty values in a column, with counts — the mapping studio's raw material. */
export function columnValues(table: SourceTable, column: string, limit = 50): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of table.rows) {
    const raw = row[column];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const value = String(raw).trim();
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
