import { openingTurn } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';
import { promptXml, speakAndHangupXml, xmlResponse } from '@/lib/voice/xml';
import { env } from '@/lib/env';

/** Plivo fetches this the moment the employee picks up. */
async function handle(request: Request) {
  const callId = new URL(request.url).searchParams.get('call') ?? '';

  const turn = await withCallContext(callId, async (ctx) => openingTurn(ctx, callId)).catch((error) => {
    console.error('[voice] answer failed:', error);
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

export const GET = handle;
export const POST = handle;
