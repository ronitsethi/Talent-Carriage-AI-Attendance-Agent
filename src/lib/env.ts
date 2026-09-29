import 'dotenv/config';
import { z } from 'zod';

/**
 * Every external dependency is optional. With none of them set the platform runs
 * fully on local fakes, which is the mode the whole product is built and tested
 * in. Adding a key switches that provider on; no code changes.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  /** The app's connection: an unprivileged role that row-level security applies to. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Owner connection, used only by migrations. Falls back to DATABASE_URL. */
  MIGRATION_DATABASE_URL: z.string().optional(),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),

  /** Global brake: nothing is delivered to a real person while this is true. */
  DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // WhatsApp (Meta Cloud API) - per tenant in the database, these are fallbacks
  WA_GRAPH_VERSION: z.string().default('v23.0'),
  WA_PHONE_NUMBER_ID: z.string().optional(),
  WA_ACCESS_TOKEN: z.string().optional(),
  WA_APP_SECRET: z.string().optional(),
  WA_VERIFY_TOKEN: z.string().optional(),

  // Models
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  SARVAM_API_KEY: z.string().optional(),
  SARVAM_CHAT_MODEL: z.string().default('sarvam-m'),
  SARVAM_STT_MODEL: z.string().default('saarika:v2'),
  SARVAM_TTS_MODEL: z.string().default('bulbul:v2'),

  // Voice telephony
  VOICE_PROVIDER: z.enum(['fake', 'plivo', 'exotel', 'acs']).default('fake'),
  /** Shared secret the LiveKit agent worker uses to reach the turn API. */
  AGENT_API_TOKEN: z.string().optional(),
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_SIP_TRUNK_ID: z.string().optional(),

  PLIVO_AUTH_ID: z.string().optional(),
  PLIVO_AUTH_TOKEN: z.string().optional(),
  PLIVO_FROM_NUMBER: z.string().optional(),
  /** Where calls to the Plivo number are forwarded, e.g. for Meta's verification call. */
  PLIVO_FORWARD_NUMBER: z.string().optional(),

  // HRMS
  HRMS_CONNECTOR: z.enum(['mock', 'file', 'rest', 'none']).default('mock'),
  MOCK_HRMS_URL: z.string().default('http://localhost:4010'),

  AUTH_SECRET: z.string().default('dev-only-change-me'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment:\n${issues}`);
}

export const env = parsed.data;

/** What is actually wired up right now — shown in the portal so nobody guesses. */
export function capabilities() {
  return {
    dryRun: env.DRY_RUN,
    whatsapp: Boolean(env.WA_PHONE_NUMBER_ID && env.WA_ACCESS_TOKEN),
    whatsappSignature: Boolean(env.WA_APP_SECRET),
    openai: Boolean(env.OPENAI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    sarvam: Boolean(env.SARVAM_API_KEY),
    voice: env.VOICE_PROVIDER,
    /** True once a spoken conversation can actually be carried. */
    voiceAgent: Boolean(
      !env.DRY_RUN && env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.LIVEKIT_SIP_TRUNK_ID,
    ),
    hrms: env.HRMS_CONNECTOR,
  };
}
