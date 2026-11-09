import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db';
import { codeMappings, mappingProfiles } from '@/db/schema';
import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';

/**
 * Which kind of leave a code is, from the one code table HR keeps on Mapping.
 *
 * The attendance codes and the leave balance file's leave types are the same
 * codes (PL, CL, SL...), so they are explained once: PL means Earned /
 * privilege leave wherever it appears. That is what lets the agent put the
 * leave taken in the attendance next to the balance left, type by type, even
 * when the balance file has no leave name, and even when the two files spell
 * the same leave differently (EL in one, PL in the other, both Earned leave).
 */

/** The meanings that are a kind of leave, for counting leave taken and naming balances. */
export const LEAVE_KINDS: readonly Meaning[] = [
  'leave_earned',
  'leave_casual',
  'leave_sick',
  'leave_maternity',
  'leave_paternity',
  'leave_marriage',
  'leave_bereavement',
  'leave_other',
  'leave_approved',
  'comp_off',
  'leave_unpaid',
];

export const isLeaveKind = (meaning: string | null | undefined): meaning is Meaning =>
  Boolean(meaning) && (LEAVE_KINDS as readonly string[]).includes(meaning!);

/** "Leave approved" says it was leave but not which: worth fixing on Mapping. */
export const isUntypedLeave = (meaning: string | null | undefined) => meaning === 'leave_approved';

export type CodeBook = {
  /** Code (upper case) to meaning. */
  codes: Map<string, Meaning>;
  /** The split between the two halves of a day in one cell, if the customer's file has it. */
  separator: string | null;
};

/** This customer's code table and its half-day separator, from the active attendance mapping. */
export async function loadCodeBook(tx: Db, tenantId: string): Promise<CodeBook> {
  const profile = await tx.query.mappingProfiles.findFirst({
    where: and(eq(mappingProfiles.tenantId, tenantId), eq(mappingProfiles.status, 'active')),
    columns: { id: true, fieldMap: true },
  });
  if (!profile) return { codes: new Map(), separator: null };
  const rules = await tx.select({ code: codeMappings.code, meaning: codeMappings.meaning }).from(codeMappings).where(eq(codeMappings.profileId, profile.id));
  const layout = profile.fieldMap.statusLayout;
  return {
    codes: new Map(rules.map((r) => [r.code.trim().toUpperCase(), r.meaning as Meaning])),
    separator: layout.kind === 'two_session' ? layout.separator : null,
  };
}

export const codeMeaning = (book: CodeBook, code: string): Meaning | null => book.codes.get(code.trim().toUpperCase()) ?? null;

/** How a leave type is named to the agent: its kind and code, else the file's own name, else the code. */
export function leaveTypeName(book: CodeBook, code: string, fileName?: string | null): string {
  const meaning = codeMeaning(book, code);
  if (meaning && isLeaveKind(meaning) && !isUntypedLeave(meaning)) return `${MEANING_LABELS[meaning]} (${code})`;
  if (fileName && fileName.toLowerCase() !== code.toLowerCase()) return `${fileName} (${code})`;
  return code;
}

type Day = { date: string; rawStatus: string | null; meaning: string };
type Taken = { kind: Meaning; codes: Set<string>; days: number; dates: string[] };

/**
 * Leave taken per kind, from the attendance: each day's own code looked up in
 * the code table, so a mapping changed since the import still counts. A cell
 * with two halves (PL|P) is half a day of PL. A day whose code is no longer in
 * the table counts by the meaning it was imported with.
 */
export function leaveTaken(days: Day[], book: CodeBook): Taken[] {
  const byKind = new Map<Meaning, Taken>();
  const add = (kind: Meaning, code: string, amount: number, date: string, half: 'first' | 'second' | null) => {
    const entry = byKind.get(kind) ?? { kind, codes: new Set<string>(), days: 0, dates: [] };
    entry.codes.add(code.toUpperCase());
    entry.days += amount;
    const day = String(Number(date.slice(8)));
    entry.dates.push(half ? `${day} (${half} half)` : day);
    byKind.set(kind, entry);
  };

  for (const day of days) {
    const raw = (day.rawStatus ?? '').trim();
    const halves = book.separator && raw.includes(book.separator) ? raw.split(book.separator).map((p) => p.trim()) : null;
    if (halves && halves.length === 2 && halves[0] && halves[1]) {
      const [first, second] = halves as [string, string];
      const a = codeMeaning(book, first);
      const b = codeMeaning(book, second);
      if (a && b && first.toUpperCase() === second.toUpperCase() && isLeaveKind(a)) {
        add(a, first, 1, day.date, null);
        continue;
      }
      if (a || b) {
        if (a && isLeaveKind(a)) add(a, first, 0.5, day.date, 'first');
        if (b && isLeaveKind(b)) add(b, second, 0.5, day.date, 'second');
        continue;
      }
    }
    const whole = raw ? codeMeaning(book, raw) : null;
    const kind = whole ?? (day.meaning as Meaning);
    if (isLeaveKind(kind)) add(kind, raw || kind, 1, day.date, null);
  }
  return [...byKind.values()];
}

/** Leave taken written out for the model, month by month. Empty when there is none. */
export function leaveTakenLines(days: Day[], book: CodeBook): string[] {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const byMonth = new Map<string, Day[]>();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), day]);
  }
  const lines: string[] = [];
  for (const [month, monthDays] of [...byMonth.entries()].sort()) {
    const taken = leaveTaken(monthDays, book);
    if (!taken.length) continue;
    const [year, m] = month.split('-');
    lines.push(`  ${MONTHS[Number(m) - 1]} ${year}:`);
    for (const t of taken) {
      const name = isUntypedLeave(t.kind) ? 'Leave, type not given' : MEANING_LABELS[t.kind];
      lines.push(`    ${name} (${[...t.codes].join(', ')}): ${t.days} ${t.days === 1 ? 'day' : 'days'} — on the ${t.dates.join(', ')}`);
    }
  }
  return lines.length
    ? ['Leave taken by type, from the attendance (a half day counts half; use this for leave taken per type):', ...lines]
    : [];
}
