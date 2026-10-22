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
import { AudioPlayer } from '@/components/audio-player';
import { callPurposeFor } from '@/lib/voice/session';

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

  const { caseRow, employee, transcript, calls, actions, approvals, manager, otherPending, lines } = detail;
  const staleSummary = summaryIsStale(caseRow.summarisedAt, lines);
  const recorded = calls.filter((call) => call.recordingUri);
  const onCall = caseRow.channel === 'voice' || employee.preferredChannel === 'voice';
  // Contacting someone about a date they have already answered means the day-2
  // reminder, so the button should not promise to ask the first question again.
  const reminder = callPurposeFor(caseRow) === 'follow_up';
  // One timeline for the date: its WhatsApp messages and what was said on its
  // calls, first contact and follow-up alike, with the follow-up marked.
  type Entry =
    | { kind: 'line'; key: string; at: string; side: 'inbound' | 'outbound'; body: string; options?: string; meta: string }
    | { kind: 'mark'; key: string; at: string; label: string };
  const followUp = followUpLabel(caseRow);
  const timeline: Entry[] = [
    ...transcript.map((message): Entry => {
      const at = message.sentAt ?? message.createdAt;
      return {
        kind: 'line',
        key: message.id,
        at: at.toISOString(),
        side: message.direction,
        body: message.body ?? '',
        options: message.buttons?.length ? message.buttons.map((b) => b.title).join(' · ') : undefined,
        meta: `${formatTime(at)} · ${message.kind}${message.status ? ` · ${message.status}` : ''}`,
      };
    }),
    ...calls.flatMap((call) =>
      (call.transcript ?? []).map((turn, index): Entry => {
        const cut = turn.heard !== undefined;
        return {
          kind: 'line',
          key: `${call.id}-${index}`,
          at: turn.at,
          side: turn.role === 'agent' ? 'outbound' : 'inbound',
          body: cut && turn.heard!.trim() ? turn.heard! : turn.text,
          meta: `${turn.role === 'agent' ? 'agent' : 'employee'}, on the call · ${formatTime(turn.at)}${cut ? (turn.heard!.trim() ? ' · cut off' : ' · not heard') : ''}`,
        };
      }),
    ),
    ...(caseRow.followUpSentAt
      ? [{ kind: 'mark', key: 'follow-up', at: new Date(caseRow.followUpSentAt.getTime() - 1).toISOString(), label: `Follow-up · ${formatTime(caseRow.followUpSentAt)}` } as Entry]
      : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
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
            <div className="section-head">
              <h2>Case</h2>
            </div>
            <dl className="kv">
              <dt>Employee</dt>
              <dd>
                {employee.fullName} ({employee.empCode})
              </dd>
              <dt>Department</dt>
              <dd>{employee.department ?? '—'}</dd>
              <dt>Manager</dt>
              <dd>{manager ? manager.fullName : 'Not mapped'}</dd>
              <dt>Contact by</dt>
              <dd>{onCall ? 'Call' : 'WhatsApp'}</dd>
              <dt>Attendance</dt>
              <dd>
                {caseRow.rawStatus ?? '—'} · {meaningLabel(caseRow.meaning)}
              </dd>
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
        <section className="card flush">
          <div className="card-head">
            <h2>Conversation</h2>
            <span className="hint mono">
              {onCall ? 'On the phone · ' : ''}
              {employee.mobileE164 ? `+${employee.mobileE164}` : 'No number on record'}
            </span>
          </div>
          {recorded.length ? (
            <div className="recordings">
              {recorded.map((call) => (
                <AudioPlayer
                  key={call.id}
                  src={`/api/recordings/call/${call.id}`}
                  label={call.startedAt ?? call.endedAt ? `Call · ${formatTime(call.startedAt ?? call.endedAt)}` : 'Call'}
                />
              ))}
            </div>
          ) : null}
          <div className="chat">
            {/* Reversed inside a column-reverse box: reads in order, opens at the newest. */}
            {timeline.some((entry) => entry.kind === 'line') ? (
              [...timeline].reverse().map((entry) =>
                entry.kind === 'mark' ? (
                  <div key={entry.key} className="chat-divider">
                    <span>{entry.label}</span>
                  </div>
                ) : (
                  <div key={entry.key} className={`bubble ${entry.side}`}>
                    {entry.body}
                    {entry.options ? <span className="options">{entry.options}</span> : null}
                    <span className="meta">{entry.meta}</span>
                  </div>
                ),
              )
            ) : (
              <div className="chat-empty">Nothing has been sent yet.</div>
            )}
          </div>

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
      </div>
    </>
  );
}
