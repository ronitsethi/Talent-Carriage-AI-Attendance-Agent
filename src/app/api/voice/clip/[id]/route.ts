import { getClip } from '@/lib/voice/say';

/** Serves a line of speech for Plivo to play. Fetched once, moments after it is made. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const audio = getClip(id.replace(/\.wav$/, ''));
  if (!audio) return new Response('gone', { status: 404 });

  return new Response(new Uint8Array(audio), {
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(audio.length), 'Cache-Control': 'no-store' },
  });
}
