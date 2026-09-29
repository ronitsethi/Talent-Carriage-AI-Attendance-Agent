import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { calls, cases, employees } from '@/db/schema';
import { closeAnsweredCall, handleTurn, openingTurn } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';
import { env } from '@/lib/env';

/**
 * The turn API the spoken agent runs on.
 *
 * It is the same `openingTurn` and `handleTurn` the keypad calls use, returned
 * as JSON instead of Plivo XML. The agent worker is therefore only ears and a
 * voice: what is asked, what an answer means and what comes next are decided
 * here, by code that is already tested, so the two kinds of call can never
 * drift apart or record an absence differently.
 *
 * The worker may phrase `speak` more naturally than it is written - that is the
 * point of a conversation - but it may not decide the flow.
 */

type Body = {
  callId?: string;
  /** Omitted on the first turn, which is the greeting. */
  caseId?: string;
  speech?: string;
  digits?: string;
  /** The line has dropped. There is no hangup webhook on a LiveKit call. */
  ended?: boolean;
};

function unauthorised() {
  return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
}

export async function POST(request: Request) {
  // The worker runs outside this process, so it carries a shared secret. Without
  // one configured the endpoint stays shut rather than open to anyone.
  const presented = request.headers.get('x-agent-token');
  if (!env.AGENT_API_TOKEN || presented !== env.AGENT_API_TOKEN) return unauthorised();

  const body = (await request.json().catch(() => ({}))) as Body;
  const callId = body.callId ?? '';

  if (body.ended) {
    // A keypad call learns it is over from Plivo's hangup webhook; a LiveKit
    // call has no such thing, so the worker says so on its way out. Without
    // this the call would sit "in progress" for ever and the portal would show
    // a conversation that is long finished.
    const closed = await withCallContext(callId, async (ctx) => {
      await closeAnsweredCall(ctx, callId, 0);
      return true;
    });
    return NextResponse.json({ closed: Boolean(closed) });
  }

  const result = await withCallContext(callId, async (ctx) => {
    const turn = body.caseId
      ? await handleTurn(ctx, callId, body.caseId, { speech: body.speech, digits: body.digits })
      : await openingTurn(ctx, callId);

    // Everything the worker needs to speak this turn and answer the next one.
    const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
    const employee = call ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, call.employeeId) }) : null;
    const current = turn.nextCaseId
      ? await ctx.tx.query.cases.findFirst({ where: eq(cases.id, turn.nextCaseId) })
      : null;

    return {
      say: [turn.intro, turn.speak].filter(Boolean).join(' '),
      intro: turn.intro ?? null,
      question: turn.speak,
      nextCaseId: turn.nextCaseId,
      done: turn.done,
      retry: turn.retry ?? false,
      purpose: call?.purpose ?? 'first_contact',
      employeeName: employee?.fullName ?? null,
      language: employee?.language ?? ctx.settings.defaultLanguage,
      company: ctx.companyName,
      attDate: current?.attDate ?? null,
    };
  });

  if (!result) return NextResponse.json({ error: 'unknown call' }, { status: 404 });
  return NextResponse.json(result);
}
