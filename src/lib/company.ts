import { eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { tenantSettings } from '@/db/schema';

/**
 * A customer's files are only ever imported into that customer.
 *
 * The Company tab on Mapping holds two things: the heading of the column that
 * names the company in this customer's files, and the company name itself as it
 * should appear there. Attendance registers, leave balance files and salary
 * registers are all checked the same way: every name in that column must be the
 * mapped company name, or the upload is refused. The customer's name in the
 * portal plays no part.
 *
 * Names are compared ignoring case, spacing, punctuation and legal-form words
 * (Private Limited, Pvt Ltd, LLP...), so "Dpod Lifestyle Pvt. Ltd." in a file is
 * "Dpod Lifestyle Private Limited" in the mapping. Blank cells are ignored.
 *
 * Nothing is checked until both fields are saved, nor for a file that has no
 * column with the mapped heading.
 */

export type CompanyMapping = { column: string; name: string };

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The column with the mapped heading, if the file has one (case and spacing ignored). */
export function companyColumn(columns: string[], heading: string): string | null {
  const wanted = norm(heading);
  return columns.find((column) => norm(column) === wanted) ?? null;
}

const FILLER = new Set(['private', 'pvt', 'limited', 'ltd', 'llp', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'the', 'and']);

/** A company name's words that matter: lower case, no punctuation, no legal-form words. */
export function companyWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !FILLER.has(word));
}

/** Whether a name in a file is the mapped company: the same words once legal-form words are set aside. */
export function sameCompany(inFile: string, mapped: string): boolean {
  const a = companyWords(inFile).join(' ');
  const b = companyWords(mapped).join(' ');
  if (!a || !b) return norm(inFile) === norm(mapped);
  return a === b;
}

/** This customer's saved company mapping, or null when either field is blank. */
export async function companyMapping(tx: Db, tenantId: string): Promise<CompanyMapping | null> {
  const row = await tx.query.tenantSettings.findFirst({
    where: eq(tenantSettings.tenantId, tenantId),
    columns: { companyColumn: true, companyName: true },
  });
  return row?.companyColumn && row.companyName ? { column: row.companyColumn, name: row.companyName } : null;
}

/**
 * Checks a file's rows against the company mapping. Null when it may be
 * imported; otherwise why not, naming the company the file is for.
 */
export function companyRefusal(
  table: { columns: string[]; rows: Record<string, unknown>[] },
  mapping: CompanyMapping | null,
  filename: string,
  kind: 'attendance' | 'payroll' | 'leave balance',
): string | null {
  if (!mapping) return null;
  const column = companyColumn(table.columns, mapping.column);
  if (!column) return null;
  const names = [...new Set(table.rows.map((row) => String(row[column] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const others = names.filter((name) => !sameCompany(name, mapping.name));
  if (!others.length) return null;
  return `${filename} is ${kind} for ${others.slice(0, 3).join(', ')}${others.length > 3 ? ' and others' : ''}, not ${mapping.name}. Check the file, or the company name on Mapping, Company tab.`;
}
