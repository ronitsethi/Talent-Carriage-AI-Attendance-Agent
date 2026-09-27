import { handleTurn } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';
import { promptXml, speakAndHangupXml, xmlResponse } from '@/lib/voice/xml';
import { env } from '@/lib/env';

/**
 * One answer from the employee: a keypad press, or what they said.
 *
 * The reply decides whether the call moves to the next pending date or ends,
 * which is how one call sweeps a whole month of absences.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const callId = url.searchParams.get('call') ?? '';
  const caseId = url.searchParams.get('case') ?? '';

  const form = await request.formData().catch(() => new FormData());
  const digits = String(form.get('Digits') ?? '').trim();
  const speech = String(form.get('Speech') ?? '').trim();

  // Worth a line in the log: when a call goes quiet, the first thing to know is
  // whether the keypad press reached us at all.
  console.log(
    `[voice] input call=${callId} case=${caseId} type=${String(form.get('InputType') ?? '-')} ` +
      `digits=${digits || '-'} speech=${speech || '-'} confidence=${String(form.get('SpeechConfidenceScore') ?? '-')}`,
  );

  const turn = await withCallContext(callId, async (ctx) =>
    handleTurn(ctx, callId, caseId, { digits: digits || undefined, speech: speech || undefined }),
  ).catch((error) => {
    console.error('[voice] input failed:', error);
    return null;
  });
  if (!turn) return xmlResponse(speakAndHangupXml('Sorry, this call is no longer valid. Goodbye.'));
  if (turn.done || !turn.nextCaseId) return xmlResponse(speakAndHangupXml(turn.speak));

  return xmlResponse(
    promptXml({
      speak: turn.speak,
      intro: turn.intro,
      actionUrl: `${env.APP_BASE_URL}/api/voice/input?call=${callId}&case=${turn.nextCaseId}`,
    }),
  );
}

export const GET = POST;
