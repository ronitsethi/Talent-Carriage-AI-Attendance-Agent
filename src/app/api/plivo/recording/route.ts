import { NextResponse } from 'next/server';

/**
 * Where Plivo reports the finished recording of a verification call.
 *
 * The URL is printed rather than stored: this runs at most a handful of times
 * in a number's life, and `npm run verify:code` finds the recording through
 * Plivo's API anyway. The log line is there so you can see, the moment the call
 * ends, that something was actually captured.
 */
async function handle(request: Request) {
  const form = await request.formData().catch(() => new FormData());
  const url = String(form.get('RecordUrl') ?? '');
  const seconds = String(form.get('RecordingDuration') ?? '?');

  console.log(`[verify] recorded ${seconds}s: ${url || '(no RecordUrl reported)'}`);
  console.log('[verify] run `npm run verify:code` to download and play it');

  // The caller has almost certainly hung up by now, but Plivo expects XML.
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>', {
    headers: { 'Content-Type': 'application/xml' },
  });
}

export const GET = handle;
export const POST = handle;
