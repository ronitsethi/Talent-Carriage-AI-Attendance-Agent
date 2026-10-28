import type { Db } from '@/db';
import { env } from '@/lib/env';
import { LIVEKIT_RATES, OPENAI_STT_PER_MINUTE, PLIVO, SARVAM } from './prices';
import { modelCost, replaceCostLines, type CostLine, type CostScope } from './record';

/**
 * What a call cost once it is over: the phone line, and on a talking call
 * LiveKit's minutes and the speech models the agent worker used.
 *
 * Written when the call ends, and again if the end is reported twice - the
 * set replaces itself rather than adding up.
 */

/** What the talking agent's worker counted on the call. */
export type WorkerUsage = {
  /** Seconds of the caller's audio sent to speech to text. */
  sttSeconds?: number;
  sttModel?: string;
  /** Characters turned into speech. */
  ttsCharacters?: number;
  ttsModel?: string;
  llmModel?: string;
  llmInputTokens?: number;
  llmOutputTokens?: number;
};

export type CallReport = {
  /** 'plivo' for the keypad line, 'livekit' for the talking agent. */
  provider: string;
  durationSeconds: number;
  /** A keypad call's charge as Plivo's hangup callback gave it: the seconds billed, and its amount in dollars. */
  plivoCharge?: { usdAmount: number; billedSeconds: number } | null;
  /** On the keypad line: answers said rather than pressed, each recognised by Plivo. */
  spokenAnswers?: number;
  worker?: WorkerUsage | null;
};

const rupees = (amount: number) => Math.round(amount * 1_000_000);

/**
 * What Plivo charged for a call, from what it reports: the seconds it billed,
 * and the amount - which its API gives in US dollars whatever the account is
 * billed in. A rupee account is charged the seconds billed at its rupee rate,
 * which is the figure the console shows; the dollar amount, converted at
 * Plivo's own exchange rate, would not match it.
 */
export function plivoCharged(billedSeconds: number, usdAmount: number, source: string) {
  if (env.PLIVO_BILLING_CURRENCY === 'USD') {
    return { amountMicros: Math.round(usdAmount * 1_000_000), currency: 'USD' as const, detail: { source } };
  }
  return {
    amountMicros: rupees((billedSeconds / 60) * PLIVO.callPerMinute),
    currency: 'INR' as const,
    detail: { source: `${source}: ${billedSeconds}s billed at ₹${PLIVO.callPerMinute}/min`, plivoUsd: usdAmount },
  };
}
const dollars = rupees;
const pulses = (seconds: number) => Math.ceil(seconds / PLIVO.pulseSeconds);
const minutes = (seconds: number) => Math.ceil(seconds / 60);

export function callCostLines(report: CallReport): CostLine[] {
  const seconds = Math.max(0, Math.round(report.durationSeconds));
  if (!seconds && !report.plivoCharge) return [];
  const lines: CostLine[] = [];
  const pulseRate = PLIVO.callPerMinute * (PLIVO.pulseSeconds / 60);

  if (report.provider === 'livekit') {
    const livekit = LIVEKIT_RATES[env.LIVEKIT_PLAN];
    lines.push({
      provider: 'Plivo',
      item: 'Phone line, over the SIP trunk',
      quantity: pulses(seconds) * PLIVO.pulseSeconds,
      unit: 'seconds',
      amountMicros: rupees(pulses(seconds) * pulseRate),
      currency: 'INR',
      detail: { rate: `₹${PLIVO.trunkPerMinute}/min, ${PLIVO.pulseSeconds}s pulse` },
    });
    lines.push({
      provider: 'LiveKit',
      item: 'SIP participant minutes',
      quantity: minutes(seconds),
      unit: 'minutes',
      amountMicros: dollars(minutes(seconds) * livekit.sipPerMinute),
      currency: 'USD',
      detail: { rate: livekit.sipPerMinute ? `$${livekit.sipPerMinute}/min, ${livekit.note}` : livekit.note },
    });
    lines.push({
      provider: 'LiveKit',
      item: 'Agent connection (WebRTC minutes)',
      quantity: minutes(seconds),
      unit: 'minutes',
      amountMicros: dollars(minutes(seconds) * livekit.webrtcPerMinute),
      currency: 'USD',
      detail: { rate: livekit.webrtcPerMinute ? `$${livekit.webrtcPerMinute}/min, ${livekit.note}` : livekit.note },
    });
    const worker = report.worker ?? {};
    // Streaming speech to text is sent the caller's audio for the whole call,
    // so it is billed for at least all of it.
    const heard = Math.ceil(Math.max(worker.sttSeconds ?? 0, seconds));
    const openaiStt = worker.sttModel?.startsWith('gpt-');
    const sttPerMinute = openaiStt ? OPENAI_STT_PER_MINUTE(worker.sttModel!) : 0;
    lines.push(
      openaiStt
        ? {
            provider: 'OpenAI',
            item: `Speech to text (${worker.sttModel})`,
            quantity: heard,
            unit: 'seconds',
            amountMicros: dollars((heard / 60) * sttPerMinute),
            currency: 'USD',
            detail: { rate: `$${sttPerMinute}/min` },
          }
        : {
            provider: 'Sarvam',
            item: `Speech to text${worker.sttModel ? ` (${worker.sttModel})` : ''}`,
            quantity: heard,
            unit: 'seconds',
            amountMicros: rupees((heard / 3600) * SARVAM.sttPerHour),
            currency: 'INR',
            detail: { rate: `₹${SARVAM.sttPerHour}/hour` },
          },
    );
    if (worker.ttsCharacters) {
      const model = worker.ttsModel ?? 'bulbul:v3';
      const per10k = SARVAM.ttsPer10kChars(model);
      lines.push({
        provider: 'Sarvam',
        item: `Text to speech (${model})`,
        quantity: worker.ttsCharacters,
        unit: 'characters',
        amountMicros: rupees((worker.ttsCharacters / 10_000) * per10k),
        currency: 'INR',
        detail: { rate: `₹${per10k}/10K characters` },
      });
    }
    if (worker.llmInputTokens || worker.llmOutputTokens) {
      const model = worker.llmModel ?? 'gpt-4.1-mini';
      const usage = { inputTokens: worker.llmInputTokens, outputTokens: worker.llmOutputTokens };
      lines.push({
        provider: 'Azure OpenAI',
        item: `Agent worker's own model (${model})`,
        quantity: (worker.llmInputTokens ?? 0) + (worker.llmOutputTokens ?? 0),
        unit: 'tokens',
        ...modelCost(model, usage),
        detail: { model, ...usage },
      });
    }
    lines.push({ provider: 'LiveKit', item: 'Recording (made by the agent itself)', quantity: minutes(seconds), unit: 'minutes', amountMicros: 0, currency: 'INR' });
    return lines;
  }

  const charge = report.plivoCharge;
  lines.push(
    charge
      ? {
          provider: 'Plivo',
          item: 'Phone call',
          quantity: charge.billedSeconds,
          unit: 'seconds',
          ...plivoCharged(charge.billedSeconds, charge.usdAmount, 'Plivo hangup callback'),
          estimated: false,
        }
      : {
          provider: 'Plivo',
          item: 'Phone call',
          quantity: pulses(seconds) * PLIVO.pulseSeconds,
          unit: 'seconds',
          amountMicros: rupees(pulses(seconds) * pulseRate),
          currency: 'INR',
          detail: { rate: `₹${PLIVO.callPerMinute}/min, ${PLIVO.pulseSeconds}s pulse` },
        },
  );
  if (report.spokenAnswers) {
    lines.push({
      provider: 'Plivo',
      item: 'Speech recognition (answers spoken, not pressed)',
      quantity: report.spokenAnswers,
      unit: 'answers',
      amountMicros: rupees(report.spokenAnswers * PLIVO.speechPer15s),
      currency: 'INR',
      detail: { rate: `₹${PLIVO.speechPer15s} per 15 seconds, one block per answer` },
    });
  }
  lines.push({ provider: 'Plivo', item: 'Recording', quantity: minutes(seconds), unit: 'minutes', amountMicros: 0, currency: 'INR' });
  return lines;
}

/** Writes a call's own costs, replacing any written for it before. */
export async function recordCallCosts(tx: Db, tenantId: string, links: Omit<CostScope, 'tenantId'>, report: CallReport) {
  const key = links.callId ? `call:${links.callId}` : `query:${links.queryId}`;
  await replaceCostLines(tx, tenantId, key, links, callCostLines(report));
}

/** Answers said rather than pressed on a keypad call, from its transcript. */
export function spokenAnswers(transcript: { role: string; text: string }[] | null | undefined): number {
  return (transcript ?? []).filter((t) => t.role === 'employee' && !t.text.startsWith('pressed ') && t.text !== '(silence)').length;
}
