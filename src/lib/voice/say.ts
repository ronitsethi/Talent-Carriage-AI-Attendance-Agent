import { createHash } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Speaking on a Plivo-driven call in the customer's own voice.
 *
 * Plivo's `<Speak>` has a voice of its own and no idea the portal exists, so an
 * incoming call sounded like a different company from an outgoing one. Here the
 * line is spoken by Sarvam, in the voice chosen in Settings, and Plivo is handed
 * the audio to play.
 *
 * The clips live in memory. They are worth a few seconds each - long enough for
 * Plivo to fetch what was just generated, and no longer, because a spoken
 * answer is about one caller and one moment.
 */

const SARVAM_TTS = 'https://api.sarvam.ai/text-to-speech';
const CLIP_LIFETIME_MS = 5 * 60 * 1000;

type Clip = { audio: Buffer; expires: number };
const clips = new Map<string, Clip>();

function sweep(): void {
  const now = Date.now();
  for (const [id, clip] of clips) if (clip.expires < now) clips.delete(id);
}

export function putClip(audio: Buffer): string {
  sweep();
  const id = createHash('sha1').update(audio).digest('hex').slice(0, 24);
  clips.set(id, { audio, expires: Date.now() + CLIP_LIFETIME_MS });
  return id;
}

export function getClip(id: string): Buffer | null {
  sweep();
  return clips.get(id)?.audio ?? null;
}

export type Voice = { speaker: string; pace: number; model?: string };

/** One line of speech, as audio. Null when Sarvam is unavailable. */
export async function synthesise(text: string, voice: Voice): Promise<Buffer | null> {
  if (!env.SARVAM_API_KEY) return null;

  try {
    const response = await fetch(SARVAM_TTS, {
      method: 'POST',
      headers: { 'api-subscription-key': env.SARVAM_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        target_language_code: 'en-IN',
        speaker: voice.speaker,
        model: voice.model ?? 'bulbul:v3-beta',
        pace: voice.pace,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const body = (await response.json()) as { audios?: string[] };
    const first = body.audios?.[0];
    if (!response.ok || !first) return null;
    return Buffer.from(first, 'base64');
  } catch {
    // A call in Plivo's voice beats a call in silence, so the caller falls back
    // to <Speak> rather than failing.
    return null;
  }
}

/**
 * Turns lines into something Plivo can say, in the customer's voice where it
 * can and its own where it cannot.
 */
export async function voiceLines(lines: string[], voice: Voice, baseUrl: string): Promise<(string | null)[]> {
  const audio = await Promise.all(lines.map((line) => synthesise(line, voice)));
  return audio.map((clip) => (clip ? `${baseUrl}/api/voice/clip/${putClip(clip)}.wav` : null));
}
