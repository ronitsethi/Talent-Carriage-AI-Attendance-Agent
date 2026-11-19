import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { promptVersions } from '@/db/schema';
import { ATTENDANCE_RULES, GUIDELINE_ANSWERER, LEAVE_RULES, LIMITS, PAYROLL_RULES, TALKING_AGENT } from './defaults';

/**
 * The six prompts staff can edit on the AI prompts page, and which text of each
 * the agent uses for a customer: that customer's active version, else the
 * all-customers active version, else the original wording in `defaults.ts`.
 * `build.ts` puts them together with the parts code keeps fixed.
 */

export const PROMPT_KEYS = ['talking_agent', 'guideline_answerer', 'attendance', 'limits', 'leave', 'payroll'] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];
export type PromptSet = Record<PromptKey, string>;

export const PROMPTS: Record<PromptKey, { title: string; what: string; usedBy: string }> = {
  talking_agent: {
    title: 'Talking agent',
    what: 'How it talks, and how it finds out what happened on an absent day.',
    usedBy: 'Calls, and typed WhatsApp replies about a date',
  },
  guideline_answerer: {
    title: 'Guideline answerer',
    what: 'How it answers questions about the uploaded guidelines and documents.',
    usedBy: 'Questions on WhatsApp, and the Guidelines test box',
  },
  attendance: {
    title: 'Attendance rules',
    what: "What it says about the employee's own attendance record.",
    usedBy: 'Both agents, on calls and WhatsApp',
  },
  limits: {
    title: 'Limits',
    what: 'What it must never say or do, when it raises a ticket, and when it hands over to HR.',
    usedBy: 'Both agents, on calls and WhatsApp',
  },
  leave: {
    title: 'Leave rules',
    what: 'What it says about leave balances.',
    usedBy: 'Both agents, on calls and WhatsApp',
  },
  payroll: {
    title: 'Payroll rules',
    what: 'What it says about salary and deductions.',
    usedBy: 'Both agents, on calls and WhatsApp',
  },
};

export const ORIGINAL: PromptSet = {
  talking_agent: TALKING_AGENT,
  guideline_answerer: GUIDELINE_ANSWERER,
  attendance: ATTENDANCE_RULES,
  limits: LIMITS,
  leave: LEAVE_RULES,
  payroll: PAYROLL_RULES,
};

export const MAX_PROMPT_LENGTH = 20_000;
export const isPromptKey = (value: string): value is PromptKey => (PROMPT_KEYS as readonly string[]).includes(value);

/* ------------------------------------------------------------------ *
 * What the agent uses
 * ------------------------------------------------------------------ */

/*
 * Kept for a short while per customer, so a turn does not read the database
 * for its prompt. A save on this server clears it at once; another server
 * picks it up within this time.
 */
const KEEP_MS = 30_000;
const kept = new Map<string, { at: number; set: PromptSet }>();

export function forgetPrompts(): void {
  kept.clear();
}

/** The active rows that apply to this customer, as one set over the original. */
export function resolvePrompts(rows: { prompt: string; tenantId: string | null; body: string }[]): PromptSet {
  const set: PromptSet = { ...ORIGINAL };
  // All-customers first, so the customer's own wins.
  for (const row of [...rows].sort((a, b) => Number(a.tenantId !== null) - Number(b.tenantId !== null))) {
    if (isPromptKey(row.prompt)) set[row.prompt] = row.body;
  }
  return set;
}

/**
 * The prompts this customer's agent uses. Read in a savepoint, so a failure
 * cannot abort the turn's own transaction; on one, the original wording is used.
 */
export async function promptsFor(tx: Db, tenantId: string): Promise<PromptSet> {
  const hit = kept.get(tenantId);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.set;
  try {
    const rows = await tx.transaction((t) =>
      t
        .select({ prompt: promptVersions.prompt, tenantId: promptVersions.tenantId, body: promptVersions.body })
        .from(promptVersions)
        .where(and(eq(promptVersions.active, true), or(isNull(promptVersions.tenantId), eq(promptVersions.tenantId, tenantId)))),
    );
    const set = resolvePrompts(rows);
    kept.set(tenantId, { at: Date.now(), set });
    return set;
  } catch (error) {
    console.error('[prompts] could not read the saved prompts, using the original wording:', (error as Error).message);
    return { ...ORIGINAL };
  }
}

/* ------------------------------------------------------------------ *
 * Versions (staff, through the platform scope)
 * ------------------------------------------------------------------ */

export type PromptVersion = typeof promptVersions.$inferSelect;

export class PromptRefused extends Error {}

/** Both scopes, for an all-customers version and for one customer's own. */
const scope = (prompt: PromptKey, tenantId: string | null) =>
  and(eq(promptVersions.prompt, prompt), tenantId ? eq(promptVersions.tenantId, tenantId) : isNull(promptVersions.tenantId));

/** Every saved version of a prompt: the all-customers ones, and this customer's own; newest first. */
export async function promptHistory(tx: Db, prompt: PromptKey, tenantId: string) {
  const [everyone, own] = await Promise.all([
    tx.select().from(promptVersions).where(scope(prompt, null)).orderBy(desc(promptVersions.number)),
    tx.select().from(promptVersions).where(scope(prompt, tenantId)).orderBy(desc(promptVersions.number)),
  ]);
  return { everyone, own };
}

/** What this customer uses for a prompt now, and where it comes from. */
export function inUse(history: { everyone: PromptVersion[]; own: PromptVersion[] }, prompt: PromptKey) {
  const own = history.own.find((v) => v.active);
  if (own) return { from: 'own' as const, version: own, body: own.body };
  const everyone = history.everyone.find((v) => v.active);
  if (everyone) return { from: 'everyone' as const, version: everyone, body: everyone.body };
  return { from: 'original' as const, version: null, body: ORIGINAL[prompt] };
}

/** Saves a new version and makes it the one in use for its scope. */
export async function savePromptVersion(
  tx: Db,
  input: { prompt: PromptKey; tenantId: string | null; body: string; note?: string | null; userId?: string | null; userName?: string | null },
): Promise<PromptVersion> {
  const body = input.body.replace(/\r\n/g, '\n').trim();
  if (!body) throw new PromptRefused('The prompt is empty. Write something, or make the original active instead.');
  if (body.length > MAX_PROMPT_LENGTH) throw new PromptRefused(`The prompt is longer than ${MAX_PROMPT_LENGTH.toLocaleString('en-IN')} characters.`);

  const [{ last }] = (await tx
    .select({ last: sql<number>`coalesce(max(${promptVersions.number}), 0)::int` })
    .from(promptVersions)
    .where(scope(input.prompt, input.tenantId))) as [{ last: number }];
  await tx.update(promptVersions).set({ active: false }).where(and(scope(input.prompt, input.tenantId), eq(promptVersions.active, true)));
  const [row] = await tx
    .insert(promptVersions)
    .values({
      prompt: input.prompt,
      tenantId: input.tenantId,
      number: last + 1,
      body,
      note: input.note?.trim().slice(0, 200) || null,
      active: true,
      createdBy: input.userId ?? null,
      createdByName: input.userName ?? null,
    })
    .returning();
  forgetPrompts();
  return row!;
}

/** Makes a saved version the one in use for its own scope. */
export async function activatePromptVersion(tx: Db, id: string): Promise<PromptVersion> {
  const version = await tx.query.promptVersions.findFirst({ where: eq(promptVersions.id, id) });
  if (!version || !isPromptKey(version.prompt)) throw new PromptRefused('That version no longer exists.');
  await tx.update(promptVersions).set({ active: false }).where(and(scope(version.prompt, version.tenantId), eq(promptVersions.active, true)));
  await tx.update(promptVersions).set({ active: true }).where(eq(promptVersions.id, id));
  forgetPrompts();
  return { ...version, active: true };
}

/**
 * Stops using any saved version in a scope: for all customers that means the
 * original wording; for one customer, the all-customers version again.
 */
export async function clearActivePrompt(tx: Db, prompt: PromptKey, tenantId: string | null): Promise<void> {
  await tx.update(promptVersions).set({ active: false }).where(and(scope(prompt, tenantId), eq(promptVersions.active, true)));
  forgetPrompts();
}

/** Deletes a saved version. The one in use cannot be deleted; another must be made active first. */
export async function deletePromptVersion(tx: Db, id: string): Promise<PromptVersion> {
  const version = await tx.query.promptVersions.findFirst({ where: eq(promptVersions.id, id) });
  if (!version) throw new PromptRefused('That version no longer exists.');
  if (version.active) throw new PromptRefused(`Version ${version.number} is in use. Make another version active first, then delete it.`);
  await tx.delete(promptVersions).where(eq(promptVersions.id, id));
  return version;
}
