import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { calls, cases, employees, queries, tenants, tenantSettings } from '@/db/schema';
import { closeAnsweredCall, handleTurn, openingTurn } from '@/lib/voice/session';
import { withCallContext } from '@/lib/voice/resolve';
import { withPlatformScope, withTenant, type Db } from '@/db';
import { answerQuestion, employeeByNumber, warmModel } from '@/lib/knowledge';
import { env } from '@/lib/env';
import { collectTimings, mark, timed } from '@/lib/timing';
import { buildContext } from '@/lib/runtime';
import { agentGender } from '@/lib/voice/voices';
import { addCallTurn, endCallQuery, startCallQuery } from '@/lib/conversation/queries';
import { addToCostScope, withCostScope } from '@/lib/costs/record';
import { recordCallCosts, type WorkerUsage } from '@/lib/costs/calls';
import { queueChargeLookup } from '@/lib/costs/plivo';
import {
  ground,
  onlyPleasantries,
  prepareGrounding,
  talkTurn,
  voiceLanguage,
  type HistoryLine,
  type TalkArgs,
  type TalkContext,
  type TalkEvent,
  type TalkResult,
} from '@/lib/conversation/talk';

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
  /**
   * Send the answer as it is written, one JSON line per piece, so the worker
   * can start speaking before the model has finished. Only for a question.
   */
  stream?: boolean;
  /**
   * A talking call: every sentence is written for the moment by the
   * conversation in `talk.ts` rather than read from the keypad script.
   */
  talk?: boolean;
  /**
   * The words heard so far, sent the moment the caller stops talking: the
   * guideline search starts on them while the final transcript is written, and
   * the turn that follows picks it up.
   */
  prepare?: string;
  /** An incoming call keeps no transcript here, so the worker sends it. */
  history?: HistoryLine[];
  /**
   * The employee cut the agent's last line off, and heard this much of it -
   * nothing, if empty. Absent when they heard it all.
   */
  heard?: string;
  /** On a call somebody made to us: the query it is filed under, from the greeting. */
  queryId?: string;
  /** With `ended`: how long the employee was on the line, as the worker timed it. */
  durationSeconds?: number;
  /** With `ended`: what the worker's speech models used, for the call's costs. */
  usage?: WorkerUsage;
};

const UNKNOWN_CALLER =
  'Sorry, this number is not on our employee records, so I cannot help over the phone. Please contact your H R team.';

type Employee = NonNullable<Awaited<ReturnType<typeof employeeByNumber>>>;

/**
 * Runs `fn` for whoever is ringing in, found by their number across every
 * customer. Null when the number is nobody's.
 */
async function withCaller<T>(
  from: string,
  fn: (caller: { tx: Db; tenantId: string; employee: Employee }) => Promise<T>,
): Promise<T | null> {
  return withPlatformScope(async (tx) => {
    const all = await timed('caller_lookup', () =>
      tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active')),
    );
    for (const tenant of all) {
      const found = await withTenant(tenant.id, async (t) => {
        const employee = await timed('caller_lookup', () => employeeByNumber(t, tenant.id, from));
        return employee ? { value: await withCostScope({ tenantId: tenant.id }, () => fn({ tx: t, tenantId: tenant.id, employee })) } : null;
      });
      if (found) return found.value;
    }
    return null;
  });
}

/**
 * One turn of a talking call, sent as it is written.
 *
 * Lines of JSON: `{"type":"lang"}` naming the language the reply is in, so the
 * voice can switch before it speaks; `{"type":"text"}` for each piece of the
 * reply; then one `{"type":"end"}` saying whether the call is over, which date
 * comes next, and where the time went - in the body, because a header has
 * already been sent by then.
 */
function streamTurn(
  run: (send: (event: TalkEvent) => void) => Promise<(TalkResult & { say?: string }) | null>,
  unknown: string,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const { result, header } = await collectTimings(() =>
          run((event) => {
            if (event.type === 'text') mark('first_text');
            send(event);
          }),
        );
        if (!result) send({ type: 'text', text: unknown });
        send({ type: 'end', done: result ? result.done : true, nextCaseId: result?.nextCaseId ?? null, timing: header });
      } catch (error) {
        console.error('[agent-turn] a talking turn failed:', error);
        send({ type: 'error' });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      // Nothing between here and the worker may hold the pieces back.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

/** The call, its employee and the date being discussed, for a talking turn. */
async function talkArgs(ctx: TalkContext, callId: string, caseId: string | undefined, said: string | null, heard?: string) {
  const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
  if (!call) return null;
  const employee = await ctx.tx.query.employees.findFirst({ where: eq(employees.id, call.employeeId) });
  const caseRow = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseId ?? call.caseId ?? '') });
  if (!employee || !caseRow) return null;
  // A reminder is only a reminder for a date that was answered; one HR has
  // since reopened is asked from the start.
  const mode: TalkArgs['mode'] = call.purpose === 'follow_up' && caseRow.replyOption ? 'follow_up' : 'first_contact';
  return { mode, employee, call, caseRow, said, heard, preparedKey: `call:${callId}` } satisfies TalkArgs;
}

/** Ways of answering the phone, so the same caller does not hear the same words every time. */
const INBOUND_GREETINGS = [
  (name: string, company: string) => `Hello ${name}, this is the attendance assistant from ${company}. How can I help?`,
  (name: string, company: string) => `Hi ${name}! ${company} attendance desk here. What can I do for you?`,
  (name: string, company: string) => `Hello ${name}, you have reached ${company}'s attendance assistant. Tell me, how can I help you today?`,
  (name: string) => `Hi ${name}, attendance assistant here. What would you like to know?`,
];

function unauthorised() {
  return NextResponse.json({ error: 'unauthorised' }, { status: 401 });
}

/**
 * Each answer carries a Server-Timing header saying where its time went, which
 * the worker logs beside its own timings: the caller hears the sum as silence.
 */
export async function POST(request: Request) {
  const { result: response, header } = await collectTimings(() => withCostScope({}, () => turn(request)));
  response.headers.set('Server-Timing', header);
  return response;
}

async function turn(request: Request) {
  // The worker runs outside this process, so it carries a shared secret. Without
  // one configured the endpoint stays shut rather than open to anyone.
  const presented = request.headers.get('x-agent-token');
  if (!env.AGENT_API_TOKEN || presented !== env.AGENT_API_TOKEN) return unauthorised();

  const body = (await request.json().catch(() => ({}))) as Body;
  const callId = body.callId ?? '';
  // A call somebody made to us is filed under its query; whatever it costs is too.
  if (body.queryId) addToCostScope({ queryId: body.queryId });

  if (body.ended && body.ask && body.queryId) {
    const queryId = body.queryId;
    const ended = await withCaller(body.ask.from, async ({ tx, tenantId }) => {
      await endCallQuery(tx, queryId);
      const query = await tx.query.queries.findFirst({ where: eq(queries.id, queryId) });
      if (query) {
        await recordCallCosts(tx, tenantId, { queryId }, {
          provider: 'livekit',
          durationSeconds: body.durationSeconds ?? Math.round((Date.now() - query.startedAt.getTime()) / 1000),
          worker: body.usage,
        });
        await queueChargeLookup({
          tenantId, key: `query:${queryId}`, via: 'trunk', number: body.ask!.from, direction: 'inbound', startedAt: query.startedAt.toISOString(),
        });
      }
      return true;
    });
    return NextResponse.json({ closed: Boolean(ended) });
  }

  if (body.ended) {
    // A keypad call learns it is over from Plivo's hangup webhook; a LiveKit
    // call has no such thing, so the worker says so on its way out. Without
    // this the call would sit "in progress" for ever and the portal would show
    // a conversation that is long finished.
    const closed = await withCallContext(callId, async (ctx) => {
      const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId) });
      // Timed by the worker from the moment they answered; an older worker sends
      // nothing, and the call is timed from its first line instead.
      const firstLine = call?.transcript?.[0]?.at;
      const seconds = body.durationSeconds ?? (firstLine ? Math.round((Date.now() - new Date(firstLine).getTime()) / 1000) : 0);
      await closeAnsweredCall(ctx, callId, seconds);
      if (call) {
        await recordCallCosts(ctx.tx, ctx.tenantId, { callId, caseId: call.caseId }, { provider: 'livekit', durationSeconds: seconds, worker: body.usage });
        await queueChargeLookup({
          tenantId: ctx.tenantId, key: `call:${callId}`, via: 'trunk', number: call.toNumber, direction: 'outbound',
          startedAt: (call.startedAt ?? new Date(Date.now() - seconds * 1000)).toISOString(),
        });
      }
      return true;
    });
    return NextResponse.json({ closed: Boolean(closed) });
  }

  if (body.prepare !== undefined) {
    const said = body.prepare;
    if (body.ask) {
      const from = body.ask.from;
      prepareGrounding(`ask:${from}`, () =>
        withCaller(from, ({ tx, tenantId, employee }) => ground(tx, tenantId, employee.id, said)),
      );
    } else {
      prepareGrounding(`call:${callId}`, () =>
        withCallContext(callId, async (ctx) => {
          const call = await ctx.tx.query.calls.findFirst({ where: eq(calls.id, callId), columns: { employeeId: true } });
          return call ? ground(ctx.tx, ctx.tenantId, call.employeeId, said) : null;
        }),
      );
    }
    // The search carries on without being waited for; the worker does wait
    // for this, to know whether to say a filler.
    return NextResponse.json({ preparing: true, onlyPleasantries: await onlyPleasantries(said) });
  }

  if (body.ask) {
    const { from, question } = body.ask;
    if (body.stream && question) {
      const queryId = body.queryId;
      return streamTurn(
        (send) =>
          withCaller(from, async ({ tx, tenantId, employee }) => {
            let reply = '';
            const result = await talkTurn(
              await buildContext(tx, tenantId),
              { mode: 'inbound', employee, call: null, caseRow: null, said: question, history: body.history, preparedKey: `ask:${from}` },
              (event) => {
                if (event.type === 'text') reply += event.text;
                send(event);
              },
            );
            // Written down as it happens, so a call that drops still leaves its record.
            if (queryId) {
              await addCallTurn(tx, queryId, employee.id, [
                { role: 'employee', text: question },
                { role: 'agent', text: reply },
              ], body.heard);
            }
            return result;
          }),
        UNKNOWN_CALLER,
      );
    }

    const found = await withCaller(from, async ({ tx: t, tenantId, employee }) => {
      const settings = await t.query.tenantSettings.findFirst({
        where: eq(tenantSettings.tenantId, tenantId),
      });
      const company = await t.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });

      // No question yet: this is the greeting, so say who is speaking - and
      // open the query the rest of the call is filed under.
      if (!question) {
        warmModel();
        const greet = INBOUND_GREETINGS[Math.floor(Math.random() * INBOUND_GREETINGS.length)]!;
        const say = greet(employee.fullName.split(/\s+/)[0] ?? employee.fullName, company?.name ?? 'your employer');
        const queryId = await startCallQuery(t, { tenantId, employeeId: employee.id, style: 'agent', greeting: say });
        addToCostScope({ queryId });
        return {
          say,
          queryId,
          language: voiceLanguage(employee.language ?? settings?.defaultLanguage),
          known: true,
          voice: settings?.agentVoice ?? 'ritu',
          gender: agentGender(settings?.agentVoice),
          pace: Number(settings?.agentVoicePace ?? 0.95),
          done: false,
        };
      }

      const reply = await answerQuestion(t, tenantId, question, {
        employeeId: employee.id,
        employeeName: employee.fullName,
        budget: 'call',
      });
      if (body.queryId) {
        await addCallTurn(t, body.queryId, employee.id, [
          { role: 'employee', text: question },
          { role: 'agent', text: reply.text },
        ], body.heard);
      }
      return {
        say: reply.text,
        known: true,
        voice: settings?.agentVoice ?? 'ritu',
        pace: Number(settings?.agentVoicePace ?? 0.95),
        // The model decides whether they were saying goodbye; it judged the
        // words, which no list of phrases can.
        done: reply.finished,
      };
    });

    if (!found) return NextResponse.json({ say: UNKNOWN_CALLER, known: false, done: true });
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
        gender: agentGender(ctx.settings.agentVoice),
        pace: Number(ctx.settings.agentVoicePace),
        language: employee?.language ?? ctx.settings.defaultLanguage,
        company: ctx.companyName,
      };
    });
    if (!brief) return NextResponse.json({ error: 'unknown call' }, { status: 404 });
    return NextResponse.json(brief);
  }

  if (body.talk && body.stream && body.caseId) {
    const said = body.speech ?? '';
    return streamTurn(
      (send) =>
        withCallContext(callId, async (ctx) => {
          const args = await talkArgs(ctx, callId, body.caseId, said, body.heard);
          return args ? talkTurn(ctx, args, send) : null;
        }),
      'Sorry, I am not able to continue this call right now. Someone from H R will contact you. Goodbye.',
    );
  }

  if (body.talk && !body.caseId) {
    // The opening, asked for while the phone is still ringing, so it is ready
    // the moment they pick up.
    warmModel();
    const opening = await withCallContext(callId, async (ctx) => {
      const args = await talkArgs(ctx, callId, undefined, null);
      if (!args) return null;
      await ctx.tx.update(calls).set({ status: 'in_progress' }).where(eq(calls.id, callId));
      let say = '';
      const result = await talkTurn(ctx, args, (event) => {
        if (event.type === 'text') say += event.text;
      });
      return { say, language: result.language, nextCaseId: result.nextCaseId, done: result.done };
    });
    if (!opening) return NextResponse.json({ error: 'unknown call' }, { status: 404 });
    return NextResponse.json(opening);
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
