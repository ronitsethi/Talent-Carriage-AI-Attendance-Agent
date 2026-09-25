import { models as defaultModels, type ModelGateway } from '@/lib/models/gateway';
import type { ModelResult } from '@/lib/models/types';
import { OPTIONS, OPTION_NUMBERS, type OptionNumber } from './flow';

export type ReplyIntentName =
  | 'was_absent'
  | 'was_working'
  | 'leave_already_applied'
  | 'regularisation_already_sent'
  | 'question'
  | 'needs_help'
  | 'opt_out'
  | 'other'
  | 'unclear';

export type Classification = {
  intent: ReplyIntentName;
  option: OptionNumber | null;
  confidence: number;
  /** 'rules' when no model was needed, which is the common case. */
  source: 'rules' | 'model';
  language?: string;
  /** Present when the employee asked something instead of answering. */
  question?: string | null;
  /** Anything worth carrying into an action: reason, leave type, another date. */
  reason?: string | null;
  leaveType?: string | null;
  dateMentioned?: string | null;
  model?: { provider: string; model: string; latencyMs: number; fallbackUsed: boolean };
};

/** Below this, the agent asks one clarifying question rather than acting. */
export const CONFIDENCE_FLOOR = 0.6;

const OPT_OUT = /\b(stop|unsubscribe|do ?not (message|contact)|band karo|mat bhejo|remove me)\b/i;
const HELP = /\b(help|hr se baat|talk to hr|call me|need help|madad|samajh nahi)\b/i;

/**
 * Rules handle the replies that must never cost money or be misread: a tapped
 * button, a bare number, or the exact option text. Everything else goes to a
 * model, which is where the product earns its keep - employees type "I was
 * sick", "punch nahi hua", "મેં રજા મૂકી છે", not menu choices.
 */
export function classifyByRules(text: string): Classification | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const digit = /^(?:option\s*)?([1-4])(?:\s*[.):\-]|\s|$)/i.exec(trimmed);
  if (digit) {
    const option = Number(digit[1]) as OptionNumber;
    return { intent: OPTIONS[option].intent, option, confidence: 1, source: 'rules' };
  }

  const lower = trimmed.toLowerCase();
  for (const n of OPTION_NUMBERS) {
    const o = OPTIONS[n];
    if ([o.label, o.templateButton, o.listTitle].some((v) => v.toLowerCase() === lower)) {
      return { intent: o.intent, option: n, confidence: 1, source: 'rules' };
    }
  }

  if (OPT_OUT.test(trimmed)) return { intent: 'opt_out', option: null, confidence: 1, source: 'rules' };
  if (HELP.test(trimmed) && trimmed.length < 40) {
    return { intent: 'needs_help', option: null, confidence: 0.9, source: 'rules' };
  }
  return null;
}

const SYSTEM_PROMPT = `You read an employee's WhatsApp reply to an HR attendance question and report what they meant.

The employee was told their attendance shows them absent on a date, and offered four options:
1 was_absent - they were not at work and have not applied anything yet (sick, personal, emergency, travel without approval)
2 was_working - they were working; attendance was not captured (forgot to punch, biometric failed, worked from site or home, was on field duty)
3 leave_already_applied - they have already applied leave and it is waiting for approval
4 regularisation_already_sent - they have already submitted a regularisation or attendance correction request

Other intents:
- question: they asked something instead of answering (leave balance, deadlines, process, who approves)
- needs_help: they want a person to contact them
- opt_out: they want the messages to stop
- other: on-topic but none of the above
- unclear: you cannot tell

Replies may be English, Hindi, Gujarati, Marathi or mixed Hinglish, and may be terse or misspelt.
Report intent "unclear" with low confidence rather than guessing. Never invent a date or a leave type
that the employee did not mention.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'option', 'confidence', 'language', 'question', 'reason', 'leave_type', 'date_mentioned'],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'was_absent',
        'was_working',
        'leave_already_applied',
        'regularisation_already_sent',
        'question',
        'needs_help',
        'opt_out',
        'other',
        'unclear',
      ],
    },
    option: { type: 'integer', enum: [0, 1, 2, 3, 4], description: '0 when no option applies' },
    confidence: { type: 'number', description: '0 to 1' },
    language: { type: 'string', description: 'ISO code of what the employee wrote, e.g. en, hi, gu' },
    question: { type: ['string', 'null'], description: 'Their question, rephrased plainly' },
    reason: { type: ['string', 'null'], description: 'Reason for the absence, only if stated' },
    leave_type: { type: ['string', 'null'], description: 'Leave type named by the employee, if any' },
    date_mentioned: { type: ['string', 'null'], description: 'Any other date they referred to, as written' },
  },
} as const;

type ModelShape = {
  intent: ReplyIntentName;
  option: number;
  confidence: number;
  language: string;
  question: string | null;
  reason: string | null;
  leave_type: string | null;
  date_mentioned: string | null;
};

export type ClassifyContext = {
  /** The date being asked about, so the model can resolve "that day". */
  dateLabel?: string;
  /** Other dates still pending, which often prompt "which day?" questions. */
  pendingDateLabels?: string[];
  language?: string;
  tenantModelOverride?: string;
  gateway?: ModelGateway;
};

/**
 * Turns whatever the employee wrote into an intent.
 *
 * Rules answer first when they can. Otherwise a model decides, and a low
 * confidence deliberately becomes "unclear" so the conversation asks once more
 * and then hands over to HR.
 */
export async function classifyReply(text: string, ctx: ClassifyContext = {}): Promise<Classification> {
  const byRules = classifyByRules(text);
  if (byRules) return byRules;

  const gateway = ctx.gateway ?? defaultModels;
  const context = [
    ctx.dateLabel ? `The question was about ${ctx.dateLabel}.` : null,
    ctx.pendingDateLabels?.length ? `Other pending dates: ${ctx.pendingDateLabels.join(', ')}.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  let result: ModelResult<ModelShape>;
  try {
    result = await gateway.json<ModelShape>(
      {
        task: 'classify_reply',
        system: SYSTEM_PROMPT,
        user: `${context}\n\nEmployee reply:\n"""${text.slice(0, 1500)}"""`.trim(),
        schemaName: 'attendance_reply',
        schema: SCHEMA as unknown as Record<string, unknown>,
        language: ctx.language,
        maxTokens: 300,
      },
      { tenantOverride: ctx.tenantModelOverride },
    );
  } catch (error) {
    // Every provider failed. Hand over rather than assume anything.
    console.error('[classify] no model available:', (error as Error).message);
    return { intent: 'unclear', option: null, confidence: 0, source: 'model' };
  }

  const raw = result.data;
  const confident = raw.confidence >= CONFIDENCE_FLOOR;
  const option = raw.option >= 1 && raw.option <= 4 ? (raw.option as OptionNumber) : null;
  const intent: ReplyIntentName = confident ? raw.intent : 'unclear';

  return {
    intent,
    // An option is only accepted when the intent is one of the four answers.
    option: confident && option && intent === OPTIONS[option].intent ? option : null,
    confidence: raw.confidence,
    source: 'model',
    language: raw.language,
    question: raw.question,
    reason: raw.reason,
    leaveType: raw.leave_type,
    dateMentioned: raw.date_mentioned,
    model: {
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      fallbackUsed: result.fallbackUsed,
    },
  };
}
