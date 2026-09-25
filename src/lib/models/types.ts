/**
 * One interface for every model provider, so the product never names a vendor.
 *
 * The gateway picks a provider per task and per language: rules where rules are
 * exact, GPT-4o mini or Claude Haiku for English and Hinglish reasoning, Sarvam
 * for Indian languages and for speech. A tenant can pin its own choice.
 */

export type ModelTask =
  | 'classify_reply' // what did the employee mean?
  | 'extract_details' // dates, leave type, reason, from free text
  | 'answer_policy' // grounded answer from the tenant's policy pack
  | 'suggest_mapping' // what does this column or code mean?
  | 'summarise' // a readable summary for HR
  | 'voice_turn'; // what to say next on a call

export type JsonSchema = Record<string, unknown>;

export type ModelRequest = {
  task: ModelTask;
  system: string;
  user: string;
  /** Name and shape of the JSON the model must return. */
  schemaName: string;
  schema: JsonSchema;
  /** BCP-47-ish language hint, e.g. en, hi, gu, mr. Drives provider choice. */
  language?: string;
  maxTokens?: number;
  temperature?: number;
};

export type ModelUsage = { inputTokens?: number; outputTokens?: number };

export type ProviderResult<T> = { data: T; model: string; usage?: ModelUsage };

export type ModelResult<T> = ProviderResult<T> & {
  provider: string;
  latencyMs: number;
  /** True when the first choice failed and another provider answered. */
  fallbackUsed: boolean;
  attempts: { provider: string; error: string }[];
};

export interface ModelProvider {
  readonly name: string;
  /** False when no key is configured; the gateway then skips it silently. */
  available(): boolean;
  /** Providers may decline a language they are poor at, rather than guess badly. */
  handlesLanguage(language: string | undefined): boolean;
  json<T>(request: ModelRequest): Promise<ProviderResult<T>>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** Indian languages where Sarvam is preferred over a general-purpose model. */
export const INDIC_LANGUAGES = ['hi', 'gu', 'mr', 'ta', 'te', 'bn', 'kn', 'ml', 'pa', 'or', 'as'] as const;

export function isIndic(language: string | undefined): boolean {
  if (!language) return false;
  const base = language.toLowerCase().split('-')[0]!;
  return (INDIC_LANGUAGES as readonly string[]).includes(base);
}
