import { and, eq, like } from 'drizzle-orm';
import { withTenant } from '@/db';
import { costLines } from '@/db/schema';
import { env } from '@/lib/env';
import { enqueue } from '@/lib/jobs/queue';

/**
 * Plivo's own charge for a call whose callback does not carry it.
 *
 * A keypad call we place is told its cost on the hangup callback. Two kinds are
 * not: a talking call, which reaches the phone network over Plivo's SIP trunk
 * on LiveKit's behalf, and a keypad call somebody makes to us. Both are looked
 * up in Plivo's call records a few minutes after they end - the record takes a
 * moment to appear - and the worked-out line is replaced by Plivo's figure.
 */

export type ChargeLookup = {
  tenantId: string;
  /** The cost lines to correct: `call:<id>` or `query:<id>`. */
  key: string;
  /** 'trunk' for a talking call, 'voice' for a keypad call with Plivo's call UUID. */
  via: 'trunk' | 'voice';
  callUuid?: string | null;
  /** On the trunk: the other party's number, and which way the call went. */
  number?: string | null;
  direction?: 'outbound' | 'inbound';
  startedAt: string;
};

type Charge = { amount: number; billedSeconds: number; uuid: string };

const RETRY_MINUTES = [2, 10, 30];

function auth(): string | null {
  if (!env.PLIVO_AUTH_ID || !env.PLIVO_AUTH_TOKEN) return null;
  return `Basic ${Buffer.from(`${env.PLIVO_AUTH_ID}:${env.PLIVO_AUTH_TOKEN}`).toString('base64')}`;
}

async function plivoGet(path: string, query: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
  const header = auth();
  if (!header) return null;
  const url = new URL(`https://api.plivo.com/v1/Account/${env.PLIVO_AUTH_ID}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Authorization: header }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Plivo answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

const utcMinute = (at: Date) => at.toISOString().slice(0, 16).replace('T', ' ');

/** A SIP trunk call to or from `number` that began around `startedAt`. */
async function trunkCharge(lookup: ChargeLookup): Promise<Charge | null> {
  const started = new Date(lookup.startedAt);
  const digits = (lookup.number ?? '').replace(/\D/g, '');
  if (!digits) return null;
  // Plivo matches numbers exactly or by prefix; the trunk may write them with or without the plus.
  for (const number of [digits, `+${digits}`]) {
    const body = await plivoGet('/Zentrunk/Call/', {
      call_direction: lookup.direction ?? 'outbound',
      [lookup.direction === 'inbound' ? 'from_number' : 'to_number']: number,
      end_time__gte: utcMinute(new Date(started.getTime() - 60_000)),
      limit: '20',
    });
    const calls = ((body?.objects as Record<string, unknown>[] | undefined) ?? []).filter((c) => c.total_amount !== undefined);
    if (!calls.length) continue;
    // The one that began nearest to when ours did.
    const nearest = calls
      .map((c) => ({ c, gap: Math.abs(new Date(`${String(c.initiation_time ?? c.answer_time)}Z`.replace(' ', 'T')).getTime() - started.getTime()) }))
      .sort((a, b) => a.gap - b.gap)[0]!;
    if (nearest.gap > 5 * 60_000) continue;
    return {
      amount: Number(nearest.c.total_amount),
      billedSeconds: Number(nearest.c.bill_duration ?? nearest.c.billed_duration ?? 0),
      uuid: String(nearest.c.call_uuid),
    };
  }
  return null;
}

/** A keypad call, by the UUID Plivo gave it. */
async function voiceCharge(lookup: ChargeLookup): Promise<Charge | null> {
  if (!lookup.callUuid) return null;
  const call = await plivoGet(`/Call/${lookup.callUuid}/`);
  if (!call || call.total_amount === undefined || call.total_amount === null) return null;
  return { amount: Number(call.total_amount), billedSeconds: Number(call.bill_duration ?? 0), uuid: lookup.callUuid };
}

/** Asks for Plivo's charge a little after the call ends. Nothing without Plivo credentials. */
export async function queueChargeLookup(lookup: ChargeLookup, attempt = 0): Promise<void> {
  if (!auth() || attempt >= RETRY_MINUTES.length) return;
  await enqueue(
    'plivo_charge',
    { ...lookup, attempt },
    { tenantId: lookup.tenantId, runAt: new Date(Date.now() + RETRY_MINUTES[attempt]! * 60_000), dedupeKey: `plivo-charge:${lookup.key}:${attempt}` },
  );
}

/** The job: Plivo's figure in place of the worked-out phone line, or another try later. */
export async function applyPlivoCharge(payload: ChargeLookup & { attempt?: number }): Promise<Record<string, unknown>> {
  const charge = payload.via === 'trunk' ? await trunkCharge(payload) : await voiceCharge(payload);
  if (!charge) {
    await queueChargeLookup(payload, (payload.attempt ?? 0) + 1);
    return { found: false, attempt: payload.attempt ?? 0 };
  }
  const updated = await withTenant(payload.tenantId, (tx) =>
    tx
      .update(costLines)
      .set({
        amountMicros: Math.round(charge.amount * 1_000_000),
        currency: env.PLIVO_BILLING_CURRENCY,
        quantity: charge.billedSeconds,
        estimated: false,
        detail: { source: `Plivo call record ${charge.uuid}` },
      })
      .where(and(eq(costLines.tenantId, payload.tenantId), like(costLines.sourceKey, `${payload.key}:%`), eq(costLines.provider, 'Plivo'), like(costLines.item, 'Phone%')))
      .returning({ id: costLines.id }),
  );
  return { found: true, amount: charge.amount, lines: updated.length };
}
