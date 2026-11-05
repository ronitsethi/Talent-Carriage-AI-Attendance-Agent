/**
 * A customer's files are only ever imported into that customer.
 *
 * Attendance registers and salary registers name the company on every row. That
 * column is found by its heading - nothing to map - and every name in it must be
 * the customer being viewed. Names are compared loosely, because the portal
 * calls a customer "DPOD Lifestyle" while its files say "Dpod Lifestyle Private
 * Limited": case, punctuation and words like Private Limited, Pvt Ltd or LLP do
 * not count, and either name may be the shorter form of the other.
 *
 * A file with no company column cannot be checked, and goes through as before.
 */

const HEADING = /^(company|company name|employer|employer name|organisation|organization|organisation name|organization name|legal entity|entity|entity name)$/;

const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The column naming the company, if the file has one. */
export function companyColumn(columns: string[]): string | null {
  return columns.find((column) => HEADING.test(norm(column))) ?? null;
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

/** Whether a name in a file is this customer: the same words, or one name's words running on inside the other's. */
export function sameCompany(inFile: string, customer: string): boolean {
  const a = companyWords(inFile).join(' ');
  const b = companyWords(customer).join(' ');
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

/**
 * Checks a file's rows against the customer being viewed. Null when it may be
 * imported; otherwise why not, naming the company the file is for.
 */
export function companyRefusal(
  table: { columns: string[]; rows: Record<string, unknown>[] },
  customer: string,
  filename: string,
  kind: 'attendance' | 'payroll',
): string | null {
  const column = companyColumn(table.columns);
  if (!column) return null;
  const names = [...new Set(table.rows.map((row) => String(row[column] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const others = names.filter((name) => !sameCompany(name, customer));
  if (!others.length) return null;
  return `${filename} is ${kind} for ${others.slice(0, 3).join(', ')}${others.length > 3 ? ' and others' : ''}, not ${customer}. Switch to that customer under Viewing customer, or upload this customer's own file.`;
}
