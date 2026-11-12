import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db';
import { actions, cases } from '@/db/schema';
import type { Meaning } from '@/lib/mapping/meanings';
import { dateLabel } from '@/lib/conversation/flow';
import type { CaseRow } from '@/lib/conversation/engine';

/**
 * The dates one manager request decides. Dates answered together - "sick all
 * three days, leave not applied yet" - go to the manager as one request: an
 * action per date, the first one asked for and the rest in `covers`.
 */

export type ActionRow = typeof actions.$inferSelect;

/**
 * Every date one request decides, the lead's first: the action it was asked
 * for and those it `covers`, each with its case. Oldest date first.
 */
export async function requestCases(tx: Db, approval: { actionId: string; covers: string[] | null }): Promise<{ action: ActionRow; caseRow: CaseRow }[]> {
  const ids = [approval.actionId, ...(approval.covers ?? [])];
  const rows = await tx
    .select({ action: actions, caseRow: cases })
    .from(actions)
    .innerJoin(cases, eq(cases.id, actions.caseId))
    .where(inArray(actions.id, ids))
    .orderBy(asc(cases.attDate));
  return rows;
}

/** The dates one request decides, as a message writes them: "3 Nov and 6 Nov". */
export function requestDates(rows: { caseRow: CaseRow }[], spoken?: (row: CaseRow) => string): string {
  const labels = rows.map(({ caseRow }) => (spoken ? spoken(caseRow) : dateLabel(caseRow.attDate, caseRow.meaning as Meaning)));
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

