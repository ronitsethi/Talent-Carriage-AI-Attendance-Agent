/**
 * Downloads the newest recorded verification call and plays it.
 *
 *   npm run verify:code
 *
 * Meta reads the six digits aloud, twice, in about fifteen seconds. The call is
 * recorded rather than forwarded, so this can be replayed until the digits are
 * certain - which is the whole point, given how few attempts Meta allows.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';

const AUTH_ID = process.env.PLIVO_AUTH_ID;
const AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;

type Recording = {
  recording_id: string;
  recording_url: string;
  recording_duration_ms: number;
  add_time: string;
  from_number?: string;
  to_number?: string;
};

async function main() {
  if (!AUTH_ID || !AUTH_TOKEN) throw new Error('PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN must be set in .env');
  const auth = 'Basic ' + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64');

  const listed = await fetch(`https://api.plivo.com/v1/Account/${AUTH_ID}/Recording/?limit=5`, {
    headers: { Authorization: auth },
  });
  if (!listed.ok) throw new Error(`Plivo refused the recording list: ${listed.status}`);

  const recordings = ((await listed.json()) as { objects?: Recording[] }).objects ?? [];
  if (!recordings.length) {
    console.log('No recordings yet. If the call has only just ended, wait a few seconds and try again.');
    return;
  }

  console.log('Recent recordings:');
  for (const r of recordings) {
    console.log(`  ${r.add_time}  ${Math.round((r.recording_duration_ms ?? 0) / 1000)}s  ${r.from_number ?? '?'} -> ${r.to_number ?? '?'}`);
  }

  const newest = recordings[0]!;
  const audio = await fetch(newest.recording_url, { headers: { Authorization: auth } });
  if (!audio.ok) throw new Error(`Could not download the recording: ${audio.status}`);

  const directory = path.resolve('recordings');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${newest.recording_id}.mp3`);
  await writeFile(file, Buffer.from(await audio.arrayBuffer()));

  console.log(`\nSaved: ${file}`);
  console.log('Playing it now - run this again to hear it as many times as you need.');
  spawn('afplay', [file], { stdio: 'inherit' }).on('error', () => {
    console.log('(Could not play it automatically. Open the file above.)');
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
