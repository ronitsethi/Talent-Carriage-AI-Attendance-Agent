/**
 * Auditions the agent's voice.
 *
 *   npm run voices              # a handful worth considering
 *   npm run voices ritu amit    # just these
 *
 * The right voice is a judgement made by ear, not from a list of names, so this
 * speaks the actual opening line in each one and saves them to `voices/`.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';

/** Sarvam's customer-care voices: warm, unhurried, Indian. */
const SHORTLIST = ['ritu', 'pooja', 'priya', 'kavya', 'rahul', 'amit', 'dev', 'rohan'];

const LINE =
  'Hello Aryan. This is the attendance assistant from Demo Industries. ' +
  'I am calling about 21 September. Our records show you were absent. ' +
  'Could you tell me what happened - were you absent that day, or were you actually working?';

async function main() {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY must be set in .env');

  const voices = process.argv.slice(2).length ? process.argv.slice(2) : SHORTLIST;
  const model = process.env.AGENT_VOICE_MODEL ?? 'bulbul:v3-beta';
  const directory = path.resolve('voices');
  await mkdir(directory, { recursive: true });

  for (const speaker of voices) {
    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: LINE,
        target_language_code: 'en-IN',
        speaker,
        model,
        pace: Number(process.env.AGENT_VOICE_PACE ?? 0.95),
      }),
    });

    const body = (await response.json()) as { audios?: string[]; error?: unknown };
    if (!response.ok || !body.audios?.length) {
      console.log(`  ${speaker.padEnd(10)} could not be generated: ${JSON.stringify(body).slice(0, 120)}`);
      continue;
    }

    const file = path.join(directory, `${speaker}.wav`);
    await writeFile(file, Buffer.from(body.audios[0]!, 'base64'));
    console.log(`  ${speaker.padEnd(10)} ${file}`);
  }

  console.log('\nPlaying them in turn. Set AGENT_VOICE in .env to the one you want.');
  for (const speaker of voices) {
    await new Promise((resolve) => {
      const player = spawn('afplay', [path.join(directory, `${speaker}.wav`)], { stdio: 'ignore' });
      player.on('close', resolve);
      player.on('error', resolve);
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
