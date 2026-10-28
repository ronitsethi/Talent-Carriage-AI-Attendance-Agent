import { NextResponse } from 'next/server';
import { closeAnsweredCall, recordNoAnswer } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';
import { eq } from 'drizzle-orm';
import { calls } from '@/db/schema';
import { recordCallCosts, spokenAnswers } from '@/lib/costs/calls';

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
  // What Plivo charged, when it says: in the account's currency, for the billed seconds.
  const totalCost = Number(form.get('TotalCost') ?? NaN);
  const billed = Number(form.get('BillDuration') ?? duration);

  await withCallContext(callId, async (ctx) => {
    const answered = duration > 0 && callStatus !== 'no-answer' && callStatus !== 'busy';
    if (answered) {
      // The conversation itself decides the outcome, and by now it usually has.
      // Picking up and saying nothing is not a confirmation, so a call that
      // reached no answer is recorded as exactly that.
      await closeAnsweredCall(ctx, callId, duration);
      const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
      if (call) {
        await recordCallCosts(ctx.tx, ctx.tenantId, { callId, caseId: call.caseId }, {
          provider: 'plivo',
          durationSeconds: duration,
          plivoCharge: Number.isFinite(totalCost) ? { usdAmount: totalCost, billedSeconds: billed } : null,
          spokenAnswers: spokenAnswers(call.transcript),
        });
      }
    } else {
      await recordNoAnswer(ctx, callId, callStatus === 'busy' ? 'busy' : 'no_answer');
    }
    console.log(`[voice] call ${callId} ended: ${callStatus || hangupCause}, ${duration}s`);
    return null;
  });

  return NextResponse.json({ received: true });
}

export const GET = POST;
