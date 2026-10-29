import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { aiBudgetTopups, aiBudgets } from '@/db/schema';
import { timed } from '@/lib/timing';
import { ModelError, type ModelUsage } from './types';

/**
 * What the Azure OpenAI features may spend, in dollars.
 *
 * The credits behind the Azure resource are shared with other services, so
 * WhatsApp and calls each get an allowance, and once it is spent they stop
 * calling the model until somebody tops it up in the console. Nothing falls
 * back to another provider instead: the point is to stop, and a stopped model
 * already ends in the safe place - the reply is "unclear" and HR takes over.
 *
 * Costs are counted here from the tokens each response reports, at Azure's list
 * price, because Azure's own cost data arrives hours late.
 */

export type AiBudget = 'whatsapp' | 'call';
export const AI_BUDGETS: AiBudget[] = ['whatsapp', 'call'];

const DEFAULT_ALLOWANCE_MICROS = 10_000_000;

/**
 * Azure Global Standard list prices, in dollars per million tokens, from the
 * Azure retail price list (October 2026). Dollars per million tokens times
 * tokens is micro-dollars, which is what is stored.
 */
const PRICES: { prefix: string; input: number; cached: number; output: number }[] = [
  { prefix: 'gpt-4.1-mini', input: 0.4, cached: 0.1, output: 1.6 },
  { prefix: 'text-embedding-3-small', input: 0.02, cached: 0.02, output: 0 },
];

/** What a response cost. A model not in the list is charged as gpt-4.1-mini, and said so. */
export function costMicros(model: string, usage: ModelUsage | undefined): number {
  let price = PRICES.find((p) => model.startsWith(p.prefix));
  if (!price) {
    console.warn(`[budget] no price for ${model}; charging it as gpt-4.1-mini`);
    price = PRICES[0]!;
  }
  // Input Azure took from its prompt cache is billed at its own, lower price.
  const cached = Math.min(usage?.cachedInputTokens ?? 0, usage?.inputTokens ?? 0);
  return Math.ceil(((usage?.inputTokens ?? 0) - cached) * price.input + cached * price.cached + (usage?.outputTokens ?? 0) * price.output);
}

export class BudgetExhausted extends ModelError {
  constructor(readonly budget: AiBudget) {
    super(`The ${budget} AI budget is used up; top it up in the console`, 'budget', false);
    this.name = 'BudgetExhausted';
  }
}

/*
 * These use the shared pool, not the caller's transaction: money spent stays
 * spent even when the work that spent it is rolled back.
 */

/**
 * The last answer per budget, kept a few seconds. On a call this check sits in
 * the silence before every reply, and a budget does not run out between one
 * sentence and the next; a top-up still takes effect within seconds.
 */
const CHECK_TTL_MS = 5_000;
const lastCheck = new Map<AiBudget, { exhausted: boolean; at: number }>();

/** Throws when the budget has nothing left. */
export async function assertBudget(budget: AiBudget): Promise<void> {
  const cached = lastCheck.get(budget);
  let exhausted: boolean;
  if (cached && Date.now() - cached.at < CHECK_TTL_MS) {
    exhausted = cached.exhausted;
  } else {
    const [row] = await timed('budget_check', () => db.select().from(aiBudgets).where(eq(aiBudgets.budget, budget)));
    exhausted = Boolean(row && row.spentMicros >= row.allowanceMicros);
    lastCheck.set(budget, { exhausted, at: Date.now() });
  }
  if (exhausted) throw new BudgetExhausted(budget);
}

export async function chargeBudget(budget: AiBudget, model: string, usage: ModelUsage | undefined): Promise<void> {
  const cost = costMicros(model, usage);
  if (cost <= 0) return;
  await timed('budget_charge', async () => db
    .insert(aiBudgets)
    .values({ budget, allowanceMicros: DEFAULT_ALLOWANCE_MICROS, spentMicros: cost })
    .onConflictDoUpdate({
      target: aiBudgets.budget,
      set: { spentMicros: sql`${aiBudgets.spentMicros} + ${cost}`, updatedAt: new Date() },
    }));
}

export type BudgetStatus = { budget: AiBudget; allowanceMicros: number; spentMicros: number };

export async function budgetStatus(): Promise<BudgetStatus[]> {
  const rows = await db.select().from(aiBudgets);
  return AI_BUDGETS.map((budget) => {
    const row = rows.find((r) => r.budget === budget);
    return { budget, allowanceMicros: row?.allowanceMicros ?? DEFAULT_ALLOWANCE_MICROS, spentMicros: row?.spentMicros ?? 0 };
  });
}

/** Allows this many more dollars to be spent. */
export async function topUpBudget(budget: AiBudget, amountMicros: number, addedBy: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(aiBudgets)
      .values({ budget, allowanceMicros: DEFAULT_ALLOWANCE_MICROS + amountMicros })
      .onConflictDoUpdate({
        target: aiBudgets.budget,
        set: { allowanceMicros: sql`${aiBudgets.allowanceMicros} + ${amountMicros}`, updatedAt: new Date() },
      });
    await tx.insert(aiBudgetTopups).values({ budget, amountMicros, addedBy });
  });
  lastCheck.delete(budget);
}
