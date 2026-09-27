import { NextResponse } from 'next/server';
import { closeAnsweredCall, recordNoAnswer } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';

/**
 * Plivo's hangup callback.
 *
 * A missed call is deliberately not retried: it behaves exactly like an ignored
 * WhatsApp message, so the date stays pending and is swept up by the next call.
 */
export async function POST(request: Request) {
  const callId = new URL(request.url).searchParams.get('call') ?? '';
  const form = await request.formData().catch(() => new FormData());
  const hangupCause = String(form.get('HangupCause') ?? '');
  const callStatus = String(form.get('CallStatus') ?? '');
  const duration = Number(form.get('Duration') ?? 0);

  await withCallContext(callId, async (ctx) => {
    const answered = duration > 0 && callStatus !== 'no-answer' && callStatus !== 'busy';
    if (answered) {
      // The conversation itself decides the outcome, and by now it usually has.
      // Picking up and saying nothing is not a confirmation, so a call that
      // reached no answer is recorded as exactly that.
      await closeAnsweredCall(ctx, callId, duration);
    } else {
      await recordNoAnswer(ctx, callId, callStatus === 'busy' ? 'busy' : 'no_answer');
    }
    console.log(`[voice] call ${callId} ended: ${callStatus || hangupCause}, ${duration}s`);
    return null;
  });

  return NextResponse.json({ received: true });
}

export const GET = POST;
