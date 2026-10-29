import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, like } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { costLines } from '@/db/schema';
import type { ModelUsage } from '@/lib/models/types';
import { MODEL_PRICES } from './prices';

/**
 * Writing down what each call and message cost.
 *
 * Work happens deep inside the conversation - a classifier here, a guideline
 * search there - far from anything that knows which call or message it is for.
 * So the places where work starts (a WhatsApp message arriving, a keypad press,
 * a turn of a talking call) open a scope naming it, and anything priced inside
 * is written against that. Outside a scope - importing a file, mapping
 * suggestions - nothing is written: that is not a conversation's cost.
 */

export type CostScope = {
  tenantId: string;
  caseId?: string | null;
  callId?: string | null;
  queryId?: string | null;
  /** The WhatsApp message being answered. */
  providerMessageId?: string | null;
};

const scopes = new AsyncLocalStorage<CostScope>();

/**
 * Runs `fn` with its costs written against `scope`, on top of any scope already
 * open. Nothing is written until a scope names the tenant.
 */
export function withCostScope<T>(scope: Partial<CostScope>, fn: () => T): T {
  return scopes.run({ ...scopes.getStore(), ...scope } as CostScope, fn);
}

/** Adds to the open scope, once what it is about is known - a query just opened, say. */
export function addToCostScope(patch: Partial<CostScope>): void {
  const scope = scopes.getStore();
  if (scope) Object.assign(scope, patch);
}

export type CostLine = {
  provider: string;
  item: string;
  quantity: number;
  unit: string;
  amountMicros: number | null;
  currency: 'INR' | 'USD';
  estimated?: boolean;
  detail?: Record<string, unknown>;
};

/*
 * Written on their own connection, without the caller waiting: on a call the
 * next sentence matters more than the bookkeeping, and money spent stays spent
 * when the work that spent it is rolled back. Tests wait for them with
 * `flushCosts`.
 */
const pending = new Set<Promise<unknown>>();

function later(work: () => Promise<unknown>) {
  const promise = work().catch((error) => console.error('[costs] could not record a cost:', (error as Error).message));
  pending.add(promise);
  void promise.finally(() => pending.delete(promise));
}

export async function flushCosts(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** One cost, written against the open scope; nothing when there is none. */
export function noteCost(line: CostLine): void {
  const scope = scopes.getStore();
  if (!scope?.tenantId) return;
  const links = { ...scope };
  later(() =>
    withTenant(links.tenantId, (tx) =>
      tx.insert(costLines).values({
        tenantId: links.tenantId,
        caseId: links.caseId ?? null,
        callId: links.callId ?? null,
        queryId: links.queryId ?? null,
        providerMessageId: links.providerMessageId ?? null,
        ...line,
        estimated: line.estimated ?? true,
        detail: line.detail ?? {},
      }),
    ),
  );
}

/** What a model's answer cost, from the tokens it reports. Null for a model with no price on file. */
export function modelCost(model: string, usage: ModelUsage | undefined): { amountMicros: number | null; currency: 'USD' | 'INR' } {
  const price = MODEL_PRICES.find((p) => model.startsWith(p.prefix));
  if (!price) return { amountMicros: null, currency: 'USD' };
  // Per million tokens, times tokens, is millionths. Cached input is part of the input, at its own price.
  const cached = Math.min(usage?.cachedInputTokens ?? 0, usage?.inputTokens ?? 0);
  return {
    amountMicros: Math.ceil(((usage?.inputTokens ?? 0) - cached) * price.input + cached * price.cached + (usage?.outputTokens ?? 0) * price.output),
    currency: price.currency,
  };
}

/** A model's answer: what it was for, which model, and its tokens. */
export function noteModelCost(provider: string, model: string, usage: ModelUsage | undefined, purpose: string): void {
  if (!usage || (!usage.inputTokens && !usage.outputTokens)) return;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  noteCost({
    provider: provider === 'openai' ? 'Azure OpenAI' : provider === 'anthropic' ? 'Anthropic' : provider === 'sarvam' ? 'Sarvam' : provider,
    item: `${purpose} (${model})`,
    quantity: tokens,
    unit: 'tokens',
    ...modelCost(model, usage),
    detail: { model, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0 },
  });
}

/**
 * Replaces a call's or a query's own lines - its minutes, its speech - with a
 * fresh set, so reporting the end twice does not count it twice. `key` names
 * the set, e.g. `call:<id>`.
 */
export async function replaceCostLines(
  tx: Db,
  tenantId: string,
  key: string,
  links: Omit<CostScope, 'tenantId'>,
  lines: CostLine[],
): Promise<void> {
  await tx.delete(costLines).where(and(eq(costLines.tenantId, tenantId), like(costLines.sourceKey, `${key}:%`)));
  if (!lines.length) return;
  await tx.insert(costLines).values(
    lines.map((line, index) => ({
      tenantId,
      caseId: links.caseId ?? null,
      callId: links.callId ?? null,
      queryId: links.queryId ?? null,
      providerMessageId: links.providerMessageId ?? null,
      sourceKey: `${key}:${index}`,
      ...line,
      estimated: line.estimated ?? true,
      detail: line.detail ?? {},
    })),
  );
}
