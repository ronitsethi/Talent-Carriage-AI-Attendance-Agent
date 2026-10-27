import * as XLSX from 'xlsx';
import { asc, inArray, notInArray, sql } from 'drizzle-orm';
import { withPlatformScope, type Db } from '@/db';
import { queryTypes } from '@/db/schema';

/**
 * The training sheet: every kind of thing an employee asks about, the words they
 * use for it, what to find out before logging it, and which COE handles it.
 *
 * It is uploaded on the COE Teams page and kept as rows, so the agent reads the
 * latest sheet with no change to code. Columns are found by their headings, not
 * their position: the sheet is edited by hand, and a column moved or added
 * should not quietly put keywords where the description belongs.
 */

export type QueryType = typeof queryTypes.$inferSelect;
export type SheetRow = Omit<QueryType, 'id' | 'createdAt' | 'updatedAt'>;

type Field = Exclude<keyof SheetRow, 'position'>;

/** Which heading is which field. The first that matches wins. */
const COLUMNS: [Field, RegExp][] = [
  ['cluster', /cluster/i],
  ['coeCode', /^\s*coe\s*(code)?\s*$/i],
  ['name', /type of query|query type/i],
  ['description', /^\s*description/i],
  ['targetVariables', /target variable|data to extract/i],
  ['keywords', /keyword|trigger phrase/i],
  ['triggerCriteria', /trigger criteria|sample caller/i],
  ['requiredInfo', /required info/i],
  ['clarifyingQuestions', /clarifying/i],
  ['routingNote', /routing/i],
];

const CODE = /^[A-Z0-9]{2,8}$/;
const clean = (value: unknown) => String(value ?? '').replace(/\r\n?/g, '\n').trim();

/** The headings of the training sheet, as the template is written out with them. */
export const SHEET_HEADINGS = [
  'Suggested Cluster',
  'COE',
  'Type of Query',
  'Description',
  'Target Variables (Data to Extract)',
  'Keywords & Trigger Phrases',
  'Trigger Criteria & Sample Caller Utterance',
  'Required Info to Capture Before Logging',
  'Suggested Clarifying Questions',
  'Suggested Routing Queue',
] as const;

const SAMPLE_ROWS: string[][] = [
  [
    'Payroll and Compensation',
    'PYC',
    'Payslip',
    'Accessing, downloading or understanding a payslip: a missing payslip, one that will not download, or a line on it the employee does not follow.',
    'Month; Issue type (missing / cannot download / wrong figure); Line item in question',
    'payslip, salary slip, can\'t download payslip, "payslip nahi mil raha", what is this deduction',
    'When the caller cannot get their payslip for a month or asks what a figure on it means. Sample: "My October payslip is not showing in the app."',
    '1. Which month\n2. Whether it is missing, will not download, or shows something they question\n3. The exact line item, if a figure is in question',
    '"Which month\'s payslip is this about?"\n"Is it not showing at all, or is a figure on it wrong?"',
    'Payroll Support - [Client] queue',
  ],
  [
    'SOPs & Guidelines',
    'EMP',
    'Grievance/Complaint',
    'A complaint about how the employee has been treated: a manager, a colleague, harassment or anything that distresses them. Always handled by a person, never answered by the agent.',
    'What happened; When; Who is involved; Whether they want it raised formally',
    'complaint, grievance, "shikayat", harassment, not happy with my manager, "manager se problem hai"',
    'When the caller describes being treated unfairly or unsafely. Sample: "I want to complain about how my manager speaks to me."',
    '1. What happened, in their own words\n2. When it happened\n3. Who is involved',
    '"Can you tell me what happened?"\n"When did this happen?"',
    'Human HR representative - urgent',
  ],
];

/**
 * A blank training sheet to fill in: the headings the upload reads, two worked
 * rows to copy the style of, and a notes sheet saying what each column is for.
 */
export function templateWorkbook(): Buffer {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[...SHEET_HEADINGS], ...SAMPLE_ROWS]);
  sheet['!cols'] = [22, 8, 30, 60, 40, 50, 60, 50, 50, 34].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(book, sheet, 'Query types');
  const notes = XLSX.utils.aoa_to_sheet([
    ['Column', 'What goes in it'],
    ['COE', 'Needed. The COE code the ticket goes to - DTE, PYC... It must match a team on COE Teams, or the ticket goes to whoever looks after the company, marked.'],
    ['Type of Query', 'Needed. One row per type; each name only once. A type keeps its tickets when its name stays the same.'],
    ['Description', 'What the type covers, in a sentence or two. The agent reads it to recognise the query.'],
    ['Keywords & Trigger Phrases', 'Words and phrases employees use, in English, Hindi or a mix.'],
    ['Trigger Criteria & Sample Caller Utterance', 'When it applies, with an example of what a caller says.'],
    ['Other columns', 'Read when present. Columns are matched by their headings, so their order does not matter.'],
    ['Replace the sample rows', 'Delete the two example rows and add your own before uploading.'],
  ]);
  notes['!cols'] = [{ wch: 40 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(book, notes, 'How to fill it in');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Reads the sheet's query types, or says everything wrong with it at once. */
export function parseQueryTypeSheet(file: ArrayBuffer | Buffer): { rows: SheetRow[] } | { errors: string[] } {
  let book: XLSX.WorkBook;
  try {
    book = XLSX.read(file, { type: 'buffer' });
  } catch {
    return { errors: ['That file could not be read as a spreadsheet. Upload the .xlsx file itself.'] };
  }

  // The first sheet with the two columns that matter; its heading row is the
  // first row naming both, within the first few.
  for (const sheetName of book.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheetName]!, { header: 1, defval: '', blankrows: false });
    const headerAt = grid.slice(0, 10).findIndex((row) => {
      const headings = row.map(clean);
      return headings.some((h) => /^\s*coe\s*(code)?\s*$/i.test(h)) && headings.some((h) => /type of query|query type/i.test(h));
    });
    if (headerAt < 0) continue;

    const headings = grid[headerAt]!.map(clean);
    const column = new Map<Field, number>();
    for (const [field, pattern] of COLUMNS) {
      const index = headings.findIndex((h, i) => pattern.test(h) && ![...column.values()].includes(i));
      if (index >= 0) column.set(field, index);
    }

    const errors: string[] = [];
    const rows: SheetRow[] = [];
    const seen = new Map<string, number>();
    grid.slice(headerAt + 1).forEach((cells, offset) => {
      const line = headerAt + offset + 2; // as the spreadsheet numbers it
      const get = (field: Field) => (column.has(field) ? clean(cells[column.get(field)!]) : '');
      const name = get('name').replace(/\s+/g, ' ');
      const coeCode = get('coeCode').toUpperCase();
      if (!name && !coeCode) return;
      if (!name) return void errors.push(`Row ${line}: the type of query is empty.`);
      if (!CODE.test(coeCode)) {
        return void errors.push(`Row ${line} (${name}): "${coeCode || 'nothing'}" is not a COE code - 2 to 8 letters or digits, like DTE.`);
      }
      const earlier = seen.get(name.toLowerCase());
      if (earlier) return void errors.push(`Row ${line}: "${name}" is already on row ${earlier}. Each type of query is listed once.`);
      seen.set(name.toLowerCase(), line);
      const optional = (field: Field) => get(field) || null;
      rows.push({
        position: rows.length + 1,
        cluster: optional('cluster'),
        coeCode,
        name,
        description: optional('description'),
        targetVariables: optional('targetVariables'),
        keywords: optional('keywords'),
        triggerCriteria: optional('triggerCriteria'),
        requiredInfo: optional('requiredInfo'),
        clarifyingQuestions: optional('clarifyingQuestions'),
        routingNote: optional('routingNote'),
      });
    });

    if (errors.length) return { errors };
    if (!rows.length) return { errors: [`"${sheetName}" has the headings but no query types under them.`] };
    return { rows };
  }
  return { errors: ['No sheet has a "COE" column and a "Type of Query" column. Check the heading row.'] };
}

/**
 * Makes the stored query types exactly the sheet's. A type keeps its id when
 * its name is unchanged, so tickets stay linked to it; one no longer in the
 * sheet goes, and tickets filed under it keep its name and COE as they were.
 */
export async function replaceQueryTypes(rows: SheetRow[]): Promise<{ added: number; updated: number; removed: number }> {
  return withPlatformScope(async (tx) => {
    const names = rows.map((r) => r.name);
    const before = await tx.select({ name: queryTypes.name }).from(queryTypes);
    const known = new Set(before.map((r) => r.name));
    const removed = before.filter((r) => !names.includes(r.name)).length;
    await tx.delete(queryTypes).where(notInArray(queryTypes.name, names));
    await tx
      .insert(queryTypes)
      .values(rows)
      .onConflictDoUpdate({
        target: queryTypes.name,
        set: {
          position: sql`excluded.position`,
          cluster: sql`excluded.cluster`,
          coeCode: sql`excluded.coe_code`,
          description: sql`excluded.description`,
          targetVariables: sql`excluded.target_variables`,
          keywords: sql`excluded.keywords`,
          triggerCriteria: sql`excluded.trigger_criteria`,
          requiredInfo: sql`excluded.required_info`,
          clarifyingQuestions: sql`excluded.clarifying_questions`,
          routingNote: sql`excluded.routing_note`,
          updatedAt: sql`now()`,
        },
      });
    const added = names.filter((n) => !known.has(n)).length;
    return { added, updated: rows.length - added, removed };
  });
}

/** The stored query types, in the sheet's order. Reads platform rows, so it can be called from any scope. */
export async function listQueryTypes(tx?: Db): Promise<QueryType[]> {
  const read = (db: Db) => db.select().from(queryTypes).orderBy(asc(queryTypes.position));
  return tx ? read(tx) : withPlatformScope(read);
}

export async function queryTypesByIds(tx: Db, ids: string[]): Promise<QueryType[]> {
  return ids.length ? tx.select().from(queryTypes).where(inArray(queryTypes.id, ids)) : [];
}
