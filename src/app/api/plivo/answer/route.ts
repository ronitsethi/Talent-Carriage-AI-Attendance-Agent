import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

/**
 * Answers a call arriving on the Plivo number, for WhatsApp verification.
 *
 * Meta verifies a number by ringing it and reading a six-digit code aloud. A
 * Plivo number has no handset, so something has to be listening.
 *
 * By default the call is *recorded*. Forwarding it to a mobile was tried first
 * and loses a race that cannot be won: Meta's robot starts reading the moment
 * Plivo answers, while the forwarded leg is still ringing, so the first digits
 * are gone before anyone picks up. A recording can be replayed as often as you
 * like. Pass `?to=<number>` to forward instead, if you ever want the old way.
 *
 * Once the number is verified, the voice agent takes this route's place.
 */
function xml(body: string) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`, {
    headers: { 'Content-Type': 'application/xml' },
  });
}

/**
 * A number as Plivo wants it, whatever shape it arrived in.
 *
 * `+` means a space in a query string, so `?to=+919…` reaches us as
 * `" 919…"` - which is how the old forwarding XML ended up dialling a number
 * with a leading space.
 */
function normalise(raw: string | undefined): string | undefined {
  const digits = (raw ?? '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : undefined;
}

function recordResponse(recordingUrl: string) {
  return xml(
    // No greeting and no beep: the robot is already talking, and anything we
    // say first is time spent not recording. `finishOnKey="none"` stops a
    // stray tone from cutting the recording short.
    `  <Record action="${recordingUrl}" method="POST" fileFormat="mp3" maxLength="60" timeout="20" ` +
      `playBeep="false" finishOnKey="none" redirect="true"/>`,
  );
}

function forwardResponse(forwardTo: string, callerId: string | undefined) {
  const caller = callerId ? ` callerId="${normalise(callerId)}"` : '';
  return xml(
    `  <Dial timeout="30" timeLimit="600"${caller}>\n` +
      `    <Number>${forwardTo}</Number>\n` +
      `  </Dial>`,
  );
}

export async function GET(request: Request) {
  const forwardTo = normalise(new URL(request.url).searchParams.get('to') ?? undefined);

  if (forwardTo) {
    console.log(`[verify] forwarding the call to ${forwardTo}`);
    return forwardResponse(forwardTo, env.PLIVO_FROM_NUMBER);
  }

  // WhatsApp code recording, parked while this number answers employees instead.
  // A Plivo number sends incoming calls to one place only, and that place is now
  // the agent. Put these two lines back to catch a verification code again.
  //
  // console.log('[verify] recording the call; run `npm run verify:code` once it ends');
  // return recordResponse(`${env.APP_BASE_URL}/api/plivo/recording`);

  // Incoming calls now reach the attendance agent.
  return NextResponse.redirect(new URL('/api/voice/inbound', env.APP_BASE_URL), 307);
}

/** Plivo posts by default; both verbs answer the same way. */
export async function POST(request: Request) {
  return GET(request);
}
