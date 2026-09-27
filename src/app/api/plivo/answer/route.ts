import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

/**
 * Answers a call arriving on the Plivo number and forwards it to a real phone.
 *
 * This exists for one practical reason: Meta verifies a WhatsApp number by
 * calling it and reading out a code. A Plivo number has no handset, so without
 * somewhere to send the call there is nobody to hear it.
 *
 * Point the number's Plivo application at this URL, answer on your mobile, and
 * write down the six digits. Later, the voice agent replaces this handler.
 */
function xml(body: string) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`, {
    headers: { 'Content-Type': 'application/xml' },
  });
}

function buildResponse(forwardTo: string | undefined, callerId: string | undefined) {
  if (!forwardTo) {
    // Nothing to forward to: say so rather than dropping the call silently.
    return xml(
      '  <Speak>This number has no forwarding number configured. Please set PLIVO_FORWARD_NUMBER.</Speak>',
    );
  }
  const caller = callerId ? ` callerId="${callerId}"` : '';
  return xml(
    `  <Speak>Connecting your call.</Speak>\n` +
      `  <Dial timeout="30" timeLimit="600"${caller}>\n` +
      `    <Number>${forwardTo}</Number>\n` +
      `  </Dial>`,
  );
}

export async function GET(request: Request) {
  const override = new URL(request.url).searchParams.get('to') ?? undefined;
  return buildResponse(override ?? env.PLIVO_FORWARD_NUMBER, env.PLIVO_FROM_NUMBER);
}

/** Plivo posts by default; both verbs answer the same way. */
export async function POST(request: Request) {
  return GET(request);
}
