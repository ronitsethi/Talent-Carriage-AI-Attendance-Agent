/**
 * List prices for everything a call or a message uses, checked 27 October 2026.
 *
 * These are the providers' published rates, before any discount, free
 * allowance or GST. Where a provider reports the real charge - Plivo, on a
 * keypad call's hangup - that is used instead and the line is not marked as an
 * estimate. Change a price here and every cost worked out from then on uses it;
 * lines already written keep the price they were written with.
 */

/** Azure OpenAI, Global Standard, in dollars per million tokens. */
export const MODEL_PRICES: { prefix: string; input: number; output: number; currency: 'USD' | 'INR' }[] = [
  { prefix: 'gpt-4.1-mini', input: 0.4, output: 1.6, currency: 'USD' },
  { prefix: 'gpt-4.1-nano', input: 0.1, output: 0.4, currency: 'USD' },
  { prefix: 'gpt-4.1', input: 2, output: 8, currency: 'USD' },
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6, currency: 'USD' },
  { prefix: 'text-embedding-3-small', input: 0.02, output: 0, currency: 'USD' },
  { prefix: 'text-embedding-3-large', input: 0.13, output: 0, currency: 'USD' },
  // Anthropic, the fallback when Azure is unwell.
  { prefix: 'claude-haiku-4-5', input: 1, output: 5, currency: 'USD' },
];

/** OpenAI transcription, in dollars per minute - only if the worker is switched to it. */
export const OPENAI_STT_PER_MINUTE = (model: string) => (model.includes('mini') ? 0.003 : 0.006);

/** Sarvam (sarvam.ai/api-pricing), in rupees. */
export const SARVAM = {
  /** Speech to text, per hour of audio, billed by the second. */
  sttPerHour: 30,
  /** Text to speech, per 10,000 characters: Bulbul v3 (beta pricing) and v2. */
  ttsPer10kChars: (model: string) => (model.startsWith('bulbul:v2') ? 15 : 30),
};

/** Plivo India (plivo.com/voice/pricing/in, /sip-trunking/pricing/in), in rupees. */
export const PLIVO = {
  /** A domestic call, either direction, per minute, billed in 30-second pulses. */
  callPerMinute: 0.38,
  pulseSeconds: 30,
  /** The same rate over the SIP trunk LiveKit's calls go out on. */
  trunkPerMinute: 0.38,
  /** Recognising what is said in a GetInput, per 15 seconds. */
  speechPer15s: 1.7,
  /** Recording a call is free; storing it is free for 90 days. */
  recordingPerMinute: 0,
};

/**
 * LiveKit Cloud (livekit.com/pricing), in dollars per minute, metered by the
 * whole minute, by plan (LIVEKIT_PLAN). Build is free up to its monthly minutes
 * - 1,000 SIP, 5,000 WebRTC - and stops rather than charging past them; Ship
 * and Scale charge these overage rates once their included minutes are used.
 */
export const LIVEKIT_RATES = {
  build: { sipPerMinute: 0, webrtcPerMinute: 0, note: 'Free on the Build plan (1,000 SIP and 5,000 WebRTC minutes a month)' },
  ship: { sipPerMinute: 0.004, webrtcPerMinute: 0.0005, note: 'Ship plan overage rate' },
  scale: { sipPerMinute: 0.003, webrtcPerMinute: 0.0004, note: 'Scale plan overage rate' },
} as const;

/**
 * WhatsApp Business Platform, India, in rupees per delivered message - from
 * Meta's INR list-rate card effective 1 October 2026. From that date utility
 * templates are charged inside the 24-hour window too, and free-form (service)
 * replies are free for the first 1,000 a month per number, then at the service
 * rate. Each delivery receipt says whether the message was billable and in
 * which category, and that decides the charge.
 */
export const WHATSAPP = {
  perMessage: { utility: 0.115, authentication: 0.115, marketing: 0.8631, service: 0.115 } as Record<string, number>,
};

export const PRICES_CHECKED = '27 Oct 2026';

/** When costs began to be written down, with the deploy that added them. */
export const COSTS_RECORDED_FROM = new Date('2026-10-27T08:00:00Z');
export const COSTS_RECORDED_FROM_LABEL = '27 Oct 2026, 1:30 pm';
