import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { caseDetail } from '@/lib/queries';
import { actionLabel, caseDateLabel, caseStatus, followUpLabel, formatTime, meaningLabel, replyLabel, statusDisplay } from '@/lib/display';
import { OPTIONS, OPTION_NUMBERS } from '@/lib/conversation/flow';
import { env } from '@/lib/env';
import { Notice } from '@/components/notice';
import { StatusPill } from '@/components/status-pill';
import { ConfirmSubmit } from '@/components/confirm';
import { closeCase, contactNow, flagForHr, resetCase, simulateCallAnswer, simulateReply, writeCaseSummary } from '@/app/actions';
import { summaryIsStale } from '@/lib/conversation/summary';
import { SummaryWriter } from '@/components/summary-writer';
import { CallHead, CallPanel, ChatHead, Thread, type Entry } from '@/components/conversation';
import { callPurposeFor } from '@/lib/voice/session';
import { PersonHead } from '@/components/person-head';
import { CostBox } from '@/components/cost-box';

export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ blocked?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { id } = await params;
  const { blocked } = await searchParams;
  const detail = await caseDetail(tenantId, id);
  if (!detail) notFound();

  const { caseRow, employee, transcript, calls, actions, approvals, manager, otherPending, lines, company, costs } = detail;
  const staleSummary = summaryIsStale(caseRow.summarisedAt, lines);
  const onCall = caseRow.channel === 'voice' || employee.preferredChannel === 'voice';
  // Contacting someone about a date they have already answered means the day-2
  // reminder, so the button should not promise to ask the first question again.
  const reminder = callPurposeFor(caseRow) === 'follow_up';
  // A case is read one channel at a time, each the way it happened: the chat as
  // the chat it was, and every call as its own panel - its recording over its
  // transcript. The case's own channel goes first, the other below it.
  const followUp = followUpLabel(caseRow);
  const chat: Entry[] = [
    ...transcript
      .filter((message) => message.body?.trim() || message.buttons?.length)
      .map((message): Entry => {
        const at = message.sentAt ?? message.createdAt;
        return {
          kind: 'turn',
          key: message.id,
          at: at.toISOString(),
          side: message.direction,
          body: message.body ?? '',
          options: message.buttons?.length ? message.buttons.map((b) => b.title).join(' · ') : undefined,
          note: message.kind === 'template' ? 'template' : undefined,
          state: message.status,
        };
      }),
    ...(caseRow.followUpSentAt
      ? [
          {
            kind: 'mark',
            key: 'follow-up',
            at: new Date(caseRow.followUpSentAt.getTime() - 1).toISOString(),
            label: `Follow-up · ${formatTime(caseRow.followUpSentAt)}`,
          } as Entry,
        ]
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  // The query hands them back newest first; they are numbered and read in the
  // order they were made, with the most recent one open.
  const spoken = [...calls].reverse().map((call) => ({
    call,
    turns: (call.transcript ?? []).map((turn, index): Entry => {
      const cut = turn.heard !== undefined;
      return {
        kind: 'turn',
        key: `${call.id}-${index}`,
        at: turn.at,
        side: turn.role === 'agent' ? 'outbound' : 'inbound',
        body: cut && turn.heard!.trim() ? turn.heard! : turn.text,
        note: cut ? (turn.heard!.trim() ? 'cut off' : 'not heard') : undefined,
      };
    }),
  }));
  const said = chat.some((entry) => entry.kind === 'turn');
  const chatBlock = (
    <>
      <ChatHead name={employee.fullName} number={employee.mobileE164} />
      <div className="chat wa">
        <Thread entries={chat} skin="wa" name={employee.fullName} empty="Nothing has been sent yet." />
      </div>
    </>
  );
  const callsBlock = (
    <>
      <CallHead calls={calls.length} number={employee.mobileE164} />
      {calls.length ? (
        <div className="calls-body">
          {/* The newest call is the one open; the earlier ones fold away. */}
          {spoken.map(({ call, turns }, index) => (
            <CallPanel
              key={call.id}
              index={index + 1}
              of={spoken.length}
              startedAt={call.startedAt ?? call.endedAt}
              seconds={call.durationSeconds}
              src={call.recordingUri ? `/api/recordings/call/${call.id}` : null}
              open={index === spoken.length - 1}
            >
              <div className="chat calls">
                <Thread entries={turns} skin="call" name={employee.fullName} empty="Nothing was said on this call." />
              </div>
            </CallPanel>
          ))}
        </div>
      ) : (
        <div className="chat calls">
          <div className="chat-empty">Nobody has been called yet.</div>
        </div>
      )}
    </>
  );
  // What the case cost, in one card under everything else, by service.
  const costCard = (
    <section className="card pad costs-card">
      <h2 className="eyebrow">Costs</h2>
      <CostBox box={costs} title="Cost of this case" at={caseRow.createdAt} open />
    </section>
  );
  const label = caseDateLabel(caseRow.attDate, caseRow.meaning);
  const answered = Boolean(caseRow.answeredAt);
  const pendingApproval = approvals.find((a) => a.decision === 'pending');
  // HR deleted this employee and chose to keep the case. It can be read, and
  // that is all: every button that would act on it is gone from here, and the
  // server actions behind them refuse it too.
  const gone = Boolean(employee.deletedAt);

  return (
    <>
      {blocked ? (
        <Notice tone="err" clear={['blocked']}>
          Nothing was sent: {blocked}.
        </Notice>
      ) : null}

      {gone ? (
        <div className="notice info plain">
          <div className="notice-body">
            <strong>{employee.fullName} has been deleted.</strong> This case is kept as a record of what was said.
            Nothing further can be sent about it, and it cannot be closed, reset or flagged — unless an attendance
            import has them again, which brings both of them back.
          </div>
        </div>
      ) : null}

      <section className="page-head">
        <Link className="back-link" href="/cases">
          ← All cases
        </Link>
        <div className="title-row">
          <h1>{employee.fullName}</h1>
          <StatusPill status={caseStatus(caseRow)} />
        </div>
        <p style={{ marginTop: 6 }}>
          {label} · {meaningLabel(caseRow.meaning)}
        </p>
      </section>

      <div className="layout details-first">
        <aside className="stack">
          <section className="card pad">
            <PersonHead
              name={employee.fullName}
              channel={onCall ? 'voice' : 'whatsapp'}
              company={company}
              at={caseRow.askedAt ?? caseRow.detectedAt}
              code={employee.empCode}
              department={employee.department}
              mobile={employee.mobileE164}
            />
            <dl className="kv card-rule">
              <dt>Attendance</dt>
              <dd>
                {caseRow.rawStatus ?? '—'} · {meaningLabel(caseRow.meaning)}
              </dd>
              <dt>Manager</dt>
              <dd>{manager ? manager.fullName : 'Not mapped'}</dd>
              <dt>Asked</dt>
              <dd>{formatTime(caseRow.askedAt)}</dd>
              <dt>Follow-up</dt>
              <dd>{followUp ? `${followUp.when} · ${followUp.note}` : '—'}</dd>
              <dt>Answered</dt>
              <dd>
                {answered ? formatTime(caseRow.answeredAt) : 'Not yet'}
                {caseRow.aiUsed ? (
                  <span className="chip info mono" style={{ marginLeft: 6 }}>
                    AI
                  </span>
                ) : null}
              </dd>
              <dt>Reply</dt>
              <dd>{replyLabel(caseRow.replyOption) ?? caseRow.replyText ?? '—'}</dd>
              <dt>Action needed</dt>
              <dd>{actionLabel(caseRow.replyOption) ?? '—'}</dd>
              {caseRow.closeReason ? (
                <>
                  <dt>Closed</dt>
                  <dd>{caseRow.closeReason}</dd>
                </>
              ) : null}
            </dl>

            {caseRow.needsHrReason ? (
              <div className="notice err inline">
                <div className="notice-body">
                  <strong>Needs HR:</strong> {caseRow.needsHrReason}
                </div>
              </div>
            ) : null}

            {gone ? (
              <p className="hint card-rule">
                Kept as a record. {employee.fullName} is deleted, so this case cannot be contacted, closed, flagged or
                reset until an attendance import brings them back.
              </p>
            ) : (
              <div className="btn-row card-rule" style={{ gap: 6 }}>
                <form action={contactNow}>
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <ConfirmSubmit
                    label={reminder ? (onCall ? 'Call about the action' : 'Send the reminder') : onCall ? 'Call now' : 'Send now'}
                    className="btn small primary"
                    title={onCall ? `Call ${employee.fullName} now?` : `Message ${employee.fullName} now?`}
                    message={
                      <p>
                        {onCall ? 'Their phone rings' : 'A WhatsApp message goes out'} straight away,{' '}
                        {reminder ? 'asking whether they have done what they said about' : 'asking about'}{' '}
                        <strong>{label}</strong>. It cannot be taken back.
                      </p>
                    }
                    confirmLabel={onCall ? 'Call now' : 'Send now'}
                  />
                </form>
                <form action={closeCase}>
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <input type="hidden" name="reason" value="Closed by HR" />
                  <button className="btn small" type="submit">
                    Close case
                  </button>
                </form>
                <form action={flagForHr}>
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <button className="btn small" type="submit">
                    Flag for HR
                  </button>
                </form>
                <form action={resetCase}>
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <button
                    className="btn small"
                    type="submit"
                    title="Clears the conversation and makes this an unasked case again"
                  >
                    Reset case
                  </button>
                </form>
              </div>
            )}
          </section>

          <section className="card pad">
            <div className="section-head">
              <h2>Summary</h2>
            </div>
            {caseRow.summary ? <p className="summary-text">{caseRow.summary}</p> : null}
            {staleSummary ? (
              <SummaryWriter write={writeCaseSummary.bind(null, caseRow.id)} hasOne={Boolean(caseRow.summary)} />
            ) : !caseRow.summary ? (
              <p className="hint">Nothing has been said yet.</p>
            ) : null}
          </section>

          {calls.length || onCall ? (
            <section className="card pad">
              <div className="section-head">
                <h2>Calls</h2>
                <span className="hint">{onCall ? 'This employee is set to Call' : 'Earlier calls'}</span>
              </div>
              {calls.length ? (
                calls.slice(0, 3).map((call) => (
                  <div key={call.id} className="kv-group">
                    <dl className="kv">
                      <dt>When</dt>
                      <dd>{formatTime(call.startedAt ?? call.endedAt)}</dd>
                      <dt>Status</dt>
                      <dd>
                        {call.status}
                        {call.outcome ? ` · ${call.outcome.replace(/_/g, ' ')}` : ''}
                      </dd>
                    </dl>
                  </div>
                ))
              ) : (
                <p className="hint">No calls yet.</p>
              )}
            </section>
          ) : null}

          {actions.length ? (
            <section className="card pad">
              <div className="section-head">
                <h2>Actions</h2>
              </div>
              {actions.map((action) => (
                <dl className="kv" key={action.id}>
                  <dt>Type</dt>
                  <dd>{action.type.replace(/_/g, ' ')}</dd>
                  <dt>Status</dt>
                  <dd>{action.status.replace(/_/g, ' ')}</dd>
                  {action.hrmsReference ? (
                    <>
                      <dt>HRMS reference</dt>
                      <dd className="mono">{action.hrmsReference}</dd>
                    </>
                  ) : null}
                  {action.lastError ? (
                    <>
                      <dt>Error</dt>
                      <dd>{action.lastError}</dd>
                    </>
                  ) : null}
                </dl>
              ))}
            </section>
          ) : null}

          {otherPending.length ? (
            <section className="card pad">
              <div className="section-head" style={{ marginBottom: 10 }}>
                <h2>Also pending</h2>
                <span className="hint">Chained, oldest first</span>
              </div>
              <div>
                {otherPending.map((row) => (
                  <div key={row.id} className="pending-row">
                    <Link href={`/cases/${row.id}`}>{row.attDate}</Link>
                    <span className="hint">{statusDisplay(row.status).label}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
        <div className="stack">
          <section className="card flush">
            {onCall ? callsBlock : chatBlock}

            {gone ? null : env.DRY_RUN && onCall ? (
              <div className="sim">
                <div className="sim-title">
                  <span className="chip warn mono caps">Dry run</span>
                  Simulate the call
                </div>
                <p className="hint" style={{ marginBottom: 10 }}>
                  What the employee presses on the keypad. Answering here runs the same flow a real call does, including the
                  summary and the next pending date.
                </p>
                <div className="sim-grid">
                  {OPTION_NUMBERS.map((n) => (
                    <form key={n} action={simulateCallAnswer}>
                      <input type="hidden" name="caseId" value={caseRow.id} />
                      <input type="hidden" name="digits" value={n} />
                      <button className="btn sim-option" type="submit">
                        <span className="n">Press {n}</span>
                        {OPTIONS[n].listTitle}
                      </button>
                    </form>
                  ))}
                </div>
                <form action={simulateCallAnswer} className="sim-text">
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <input
                    className="input"
                    name="speech"
                    aria-label="What the employee says"
                    placeholder='Or say something, e.g. "I was working"'
                    required
                  />
                  <button className="btn primary" type="submit">
                    Speak
                  </button>
                </form>
              </div>
            ) : env.DRY_RUN ? (
              <div className="sim">
                <div className="sim-title">
                  <span className="chip warn mono caps">Dry run</span>
                  Simulate the employee&apos;s reply
                </div>
                <div className="sim-grid">
                  {OPTION_NUMBERS.map((n) => (
                    <form key={n} action={simulateReply}>
                      <input type="hidden" name="caseId" value={caseRow.id} />
                      <input type="hidden" name="option" value={n} />
                      <input type="hidden" name="text" value={OPTIONS[n].listTitle} />
                      <button className="btn sim-option" type="submit">
                        <span className="n">{n}</span>
                        {OPTIONS[n].listTitle}
                      </button>
                    </form>
                  ))}
                </div>
                <form action={simulateReply} className="sim-text">
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <input
                    className="input"
                    name="text"
                    aria-label="What the employee writes"
                    placeholder='Type anything, e.g. "I was sick"'
                    required
                  />
                  <button className="btn primary" type="submit">
                    Send
                  </button>
                </form>

                {pendingApproval && manager?.mobileE164 ? (
                  <>
                    <div className="sim-sub">Simulate {manager.fullName}&apos;s decision</div>
                    <div className="sim-grid">
                      {(['approve', 'reject'] as const).map((choice) => (
                        <form key={choice} action={simulateReply}>
                          <input type="hidden" name="caseId" value={caseRow.id} />
                          <input type="hidden" name="from" value={manager.mobileE164 ?? ''} />
                          <input type="hidden" name="selection" value={`appr:${pendingApproval.id}:${choice}`} />
                          <button className="btn small" type="submit">
                            {choice === 'approve' ? 'Approve' : 'Reject'}
                          </button>
                        </form>
                      ))}
                    </div>
                  </>
                ) : null}

                {caseRow.status === 'awaiting_action' ? (
                  <>
                    <div className="sim-sub">Answer the agent&apos;s offer</div>
                    <div className="sim-grid">
                      {(['accept', 'self'] as const).map((choice) => (
                        <form key={choice} action={simulateReply}>
                          <input type="hidden" name="caseId" value={caseRow.id} />
                          <input type="hidden" name="selection" value={`offer:${caseRow.id}:${choice}`} />
                          <button className="btn small" type="submit">
                            {choice === 'accept' ? 'Yes, apply it' : "I'll do it myself"}
                          </button>
                        </form>
                      ))}
                    </div>
                  </>
                ) : null}

                {caseRow.followUpSentAt && !caseRow.followUpReply ? (
                  <>
                    <div className="sim-sub">Answer the day-2 reminder</div>
                    <div className="sim-grid three">
                      {(['done', 'not_done', 'help'] as const).map((choice) => (
                        <form key={choice} action={simulateReply}>
                          <input type="hidden" name="caseId" value={caseRow.id} />
                          <input type="hidden" name="selection" value={`fu:${caseRow.id}:${choice}`} />
                          <button className="btn small" type="submit">
                            {choice === 'done' ? 'Done' : choice === 'not_done' ? 'Not done' : 'Need help'}
                          </button>
                        </form>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="sim-off">Simulation is disabled because the platform is live. Replies arrive through the webhook.</div>
            )}
          </section>

          {/* Whatever happened on the other channel, under the one this case runs on. */}
          {onCall && said ? <section className="card flush">{chatBlock}</section> : null}
          {!onCall && calls.length ? <section className="card flush">{callsBlock}</section> : null}
          {costCard}
        </div>
      </div>
    </>
  );
}
