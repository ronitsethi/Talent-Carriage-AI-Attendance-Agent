import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { calls, cases, employees, tenants, tenantSettings } from '@/db/schema';
import { closeAnsweredCall, handleTurn, openingTurn } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';
import { withPlatformScope, withTenant } from '@/db';
import { answerQuestion, employeeByNumber, isFarewell } from '@/lib/knowledge';
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
  /** Describe the call without advancing it: which voice, whose language. */
  brief?: boolean;
  /**
   * Somebody rang in and asked something. There is no case and no script - the
   * caller's number says who they are and the question is answered from their
   * employer's guidelines and their own record.
   */
  ask?: { from: string; question?: string };
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

  if (body.ask) {
    const { from, question } = body.ask;

    const found = await withPlatformScope(async (tx) => {
      const all = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
      for (const tenant of all) {
        const answer = await withTenant(tenant.id, async (t) => {
          const employee = await employeeByNumber(t, tenant.id, from);
          if (!employee) return null;
          const settings = await t.query.tenantSettings.findFirst({
            where: eq(tenantSettings.tenantId, tenant.id),
          });
          const company = await t.query.tenants.findFirst({ where: eq(tenants.id, tenant.id) });

          // No question yet: this is the greeting, so say who is speaking.
          if (!question) {
            return {
              say: `Hello ${employee.fullName.split(/\s+/)[0]}. This is the attendance assistant from ${company?.name ?? 'your employer'}. What would you like to know?`,
              known: true,
              voice: settings?.agentVoice ?? 'ritu',
              pace: Number(settings?.agentVoicePace ?? 0.95),
              done: false,
            };
          }

          // They have finished rather than asked something. Said here, not in
          // the worker, because this is where the words are understood.
          if (isFarewell(question)) {
            return {
              say: 'Glad to help. Goodbye.',
              known: true,
              voice: settings?.agentVoice ?? 'ritu',
              pace: Number(settings?.agentVoicePace ?? 0.95),
              done: true,
            };
          }

          const reply = await answerQuestion(t, tenant.id, question, {
            employeeId: employee.id,
            employeeName: employee.fullName,
          });
          return {
            say: reply.text,
            known: true,
            voice: settings?.agentVoice ?? 'ritu',
            pace: Number(settings?.agentVoicePace ?? 0.95),
            done: false,
          };
        });
        if (answer) return answer;
      }
      return null;
    });

    if (!found) {
      return NextResponse.json({
        say: 'Sorry, this number is not on our employee records, so I cannot help over the phone. Please contact your H R team.',
        known: false,
        done: true,
      });
    }
    return NextResponse.json(found);
  }

  if (body.brief) {
    // Asked before the agent opens its mouth, so the voice belongs to the
    // customer being called rather than to whatever the worker was started with.
    const brief = await withCallContext(callId, async (ctx) => {
      const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
      const employee = call
        ? await ctx.tx.query.employees.findFirst({ where: eq(employees.id, call.employeeId) })
        : null;
      return {
        voice: ctx.settings.agentVoice,
        pace: Number(ctx.settings.agentVoicePace),
        language: employee?.language ?? ctx.settings.defaultLanguage,
        company: ctx.companyName,
      };
    });
    if (!brief) return NextResponse.json({ error: 'unknown call' }, { status: 404 });
    return NextResponse.json(brief);
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
