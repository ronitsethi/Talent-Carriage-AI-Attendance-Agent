import { Readable } from 'node:stream';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { env } from '@/lib/env';

/**
 * Call recordings, kept in a private container of the attendance storage account.
 *
 * A call is recorded wherever it is carried: the talking agent records both
 * sides itself and sends the file here, and Plivo records a keypad call and
 * says where to collect it. Either way it ends up at one path in one container,
 * and nothing in that container can be fetched except through this app, by
 * somebody signed in to the customer the call belongs to.
 */

export type RecordingKind = 'calls' | 'queries';

const TYPES = { ogg: 'audio/ogg', mp3: 'audio/mpeg' } as const;
export type RecordingFormat = keyof typeof TYPES;

let container: ContainerClient | null = null;

function bucket(): ContainerClient {
  if (!env.RECORDINGS_CONNECTION_STRING) throw new Error('RECORDINGS_CONNECTION_STRING is not set');
  container ??= BlobServiceClient.fromConnectionString(env.RECORDINGS_CONNECTION_STRING).getContainerClient(
    env.RECORDINGS_CONTAINER,
  );
  return container;
}

export const recordingsConfigured = () => Boolean(env.RECORDINGS_CONNECTION_STRING);

/** Where a call's or a query's audio is kept. */
export const recordingPath = (kind: RecordingKind, id: string, format: RecordingFormat) => `${kind}/${id}.${format}`;

export async function saveRecording(path: string, audio: Buffer): Promise<void> {
  const format = path.split('.').pop() as RecordingFormat;
  await bucket()
    .getBlockBlobClient(path)
    .uploadData(audio, { blobHTTPHeaders: { blobContentType: TYPES[format] ?? 'application/octet-stream' } });
}

/**
 * The audio, or the part of it a player asked for. Players ask for ranges to
 * seek, and without them a recording can only be played from the start.
 */
export async function readRecording(path: string, range: { start: number; end?: number } | null) {
  const blob = bucket().getBlobClient(path);
  const size = (await blob.getProperties()).contentLength ?? 0;
  const start = Math.min(range?.start ?? 0, Math.max(size - 1, 0));
  const end = Math.min(range?.end ?? size - 1, size - 1);
  const download = await blob.download(start, end - start + 1);
  const body = download.readableStreamBody as Readable;
  return {
    body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
    size,
    start,
    end,
    contentType: TYPES[path.split('.').pop() as RecordingFormat] ?? 'application/octet-stream',
  };
}

/**
 * A recording Plivo made, collected from Plivo.
 *
 * Plivo posts where the file is, and anyone can post to that webhook, so only a
 * Plivo address is fetched - never somewhere a stranger chose.
 */
export async function fetchPlivoRecording(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/(^|\.)plivo\.com$/.test(parsed.hostname)) {
    throw new Error(`refusing to fetch a recording from ${parsed.hostname}`);
  }
  const auth = Buffer.from(`${env.PLIVO_AUTH_ID ?? ''}:${env.PLIVO_AUTH_TOKEN ?? ''}`).toString('base64');
  const response = await fetch(parsed, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Plivo answered ${response.status} for the recording`);
  return Buffer.from(await response.arrayBuffer());
}
