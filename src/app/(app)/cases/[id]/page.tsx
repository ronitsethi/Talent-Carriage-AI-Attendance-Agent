import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { caseDetail } from '@/lib/queries';
import { actionLabel, caseDateLabel, formatTime, meaningLabel, replyLabel, statusDisplay } from '@/lib/display';
import { OPTIONS, OPTION_NUMBERS } from '@/lib/conversation/flow';
import { env } from '@/lib/env';
import { closeCase, contactNow, flagForHr, resetCase, simulateCallAnswer, simulateReply } from '@/app/actions';
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

  const { caseRow, employee, transcript, calls, actions, approvals, manager, otherPending } = detail;
  const onCall = caseRow.channel === 'voice' || employee.preferredChannel === 'voice';
  // Contacting someone about a date they have already answered means the day-2
  // reminder, so the button should not promise to ask the first question again.
  const reminder = callPurposeFor(caseRow) === 'follow_up';
  const liveCall = calls.find((c) => ['queued', 'ringing', 'in_progress', 'simulated'].includes(c.status));
  // For a voice case the call transcript *is* the conversation.
  const callTurns = calls.flatMap((c) => c.transcript ?? []).sort((a, b) => a.at.localeCompare(b.at));
  const display = statusDisplay(caseRow.status);
  const label = caseDateLabel(caseRow.attDate, caseRow.meaning);
  const answered = Boolean(caseRow.answeredAt);
  const pendingApproval = approvals.find((a) => a.decision === 'pending');

  return (
    <>
      {blocked ? (
        <div className="notice err" style={{ marginTop: 16 }}>
          Nothing was sent: {blocked}.
        </div>
      ) : null}
      <section className="page-head">
        <div className="eyebrow">
          <Link href="/cases">← All cases</Link>
        </div>
        <h1>{employee.fullName}</h1>
        <p>
          {label} · {meaningLabel(caseRow.meaning)} · <span className={`pill ${display.tone}`}>{display.label}</span>
        </p>
      </section>

      <div className="layout">
        <div>
          <section className="card pad">
            <div className="section-head">
              <h2>Conversation</h2>
              <span className="hint">
                {onCall ? 'On the phone · ' : ''}
                {employee.mobileE164 ? `+${employee.mobileE164}` : 'No number on record'}
              </span>
            </div>
            <div className="chat">
              {/* Reversed inside a column-reverse box: reads in order, opens at the newest. */}
              {onCall && !transcript.length && callTurns.length ? (
                [...callTurns].reverse().map((turn, index) => (
                  <div key={index} className={`bubble ${turn.role === 'agent' ? 'outbound' : 'inbound'}`}>
                    {turn.text}
                    <span className="meta">
                      {turn.role === 'agent' ? 'agent, on the call' : 'employee'} · {formatTime(turn.at)}
                    </span>
                  </div>
                ))
              ) : transcript.length ? (
                [...transcript].reverse().map((message) => (
                  <div key={message.id} className={`bubble ${message.direction}`}>
                    {message.body}
                    {message.buttons?.length ? (
                      <span className="options">{message.buttons.map((b) => b.title).join(' · ')}</span>
                    ) : null}
                    <span className="meta">
                      {formatTime(message.createdAt)} · {message.kind}
                      {message.status ? ` · ${message.status}` : ''}
                    </span>
                  </div>
                ))
              ) : (
                <div className="bubble outbound">Nothing has been sent yet.</div>
              )}
            </div>

            {env.DRY_RUN && onCall ? (
              <div className="sim">
                <div className="sim-title">Simulate the call (dry run)</div>
                <p className="hint" style={{ marginBottom: 8 }}>
                  What the employee presses on the keypad. Answering here runs the same flow a real call does, including
                  the summary and the next pending date.
                </p>
                <div className="sim-grid">
                  {OPTION_NUMBERS.map((n) => (
                    <form key={n} action={simulateCallAnswer}>
                      <input type="hidden" name="caseId" value={caseRow.id} />
                      <input type="hidden" name="digits" value={n} />
                      <button className="btn small" type="submit" style={{ width: '100%' }}>
                        Press {n} · {OPTIONS[n].listTitle}
                      </button>
                    </form>
                  ))}
                </div>
                <form action={simulateCallAnswer} className="sim-text">
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <input className="input" name="speech" placeholder='Or say something, e.g. "I was working"' required />
                  <button className="btn small primary" type="submit">
                    Speak
                  </button>
                </form>
              </div>
            ) : env.DRY_RUN ? (
              <div className="sim">
                <div className="sim-title">Simulate the employee&apos;s reply (dry run)</div>
                <div className="sim-grid">
                  {OPTION_NUMBERS.map((n) => (
                    <form key={n} action={simulateReply}>
                      <input type="hidden" name="caseId" value={caseRow.id} />
                      <input type="hidden" name="option" value={n} />
                      <input type="hidden" name="text" value={OPTIONS[n].listTitle} />
                      <button className="btn small" type="submit" style={{ width: '100%' }}>
                        {n} · {OPTIONS[n].listTitle}
                      </button>
                    </form>
                  ))}
                </div>
                <form action={simulateReply} className="sim-text">
                  <input type="hidden" name="caseId" value={caseRow.id} />
                  <input className="input" name="text" placeholder='Type anything, e.g. "I was sick"' required />
                  <button className="btn small primary" type="submit">
                    Send
                  </button>
                </form>

                {pendingApproval && manager?.mobileE164 ? (
                  <>
                    <div className="sim-title" style={{ marginTop: 14 }}>
                      Simulate {manager.fullName}&apos;s decision
                    </div>
                    <div className="sim-grid">
                      {(['approve', 'reject'] as const).map((choice) => (
                        <form key={choice} action={simulateReply}>
                          <input type="hidden" name="caseId" value={caseRow.id} />
                          <input type="hidden" name="from" value={manager.mobileE164 ?? ''} />
                          <input type="hidden" name="selection" value={`appr:${pendingApproval.id}:${choice}`} />
                          <button className="btn small" type="submit" style={{ width: '100%' }}>
                            {choice === 'approve' ? 'Approve' : 'Reject'}
                          </button>
                        </form>
                      ))}
                    </div>
                  </>
                ) : null}

                {caseRow.status === 'awaiting_action' ? (
                  <>
                    <div className="sim-title" style={{ marginTop: 14 }}>
                      Answer the agent&apos;s offer
                    </div>
                    <div className="sim-grid">
                      {(['accept', 'self'] as const).map((choice) => (
                        <form key={choice} action={simulateReply}>
                          <input type="hidden" name="caseId" value={caseRow.id} />
                          <input type="hidden" name="selection" value={`offer:${caseRow.id}:${choice}`} />
                          <button className="btn small" type="submit" style={{ width: '100%' }}>
                            {choice === 'accept' ? 'Yes, apply it' : "I'll do it myself"}
                          </button>
                        </form>
                      ))}
                    </div>
                  </>
                ) : null}

                {caseRow.followUpSentAt && !caseRow.followUpReply ? (
                  <>
                    <div className="sim-title" style={{ marginTop: 14 }}>
                      Answer the day-2 reminder
                    </div>
                    <div className="sim-grid">
                      {(['done', 'not_done', 'help'] as const).map((choice) => (
                        <form key={choice} action={simulateReply}>
                          <input type="hidden" name="caseId" value={caseRow.id} />
                          <input type="hidden" name="selection" value={`fu:${caseRow.id}:${choice}`} />
                          <button className="btn small" type="submit" style={{ width: '100%' }}>
                            {choice === 'done' ? 'Done' : choice === 'not_done' ? 'Not done' : 'Need help'}
                          </button>
                        </form>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="notice info" style={{ margin: '14px 0 0' }}>
                Simulation is disabled because the platform is live. Replies arrive through the webhook.
              </div>
            )}
          </section>
        </div>

        <aside>
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
              <dt>Answered</dt>
              <dd>
                {answered ? formatTime(caseRow.answeredAt) : 'Not yet'}
                {caseRow.aiUsed ? <span className="pill waiting" style={{ marginLeft: 6 }}>AI</span> : null}
              </dd>
              <dt>Reply</dt>
              <dd>{replyLabel(caseRow.replyOption) ?? caseRow.replyText ?? '—'}</dd>
              <dt>Action needed</dt>
              <dd>{actionLabel(caseRow.replyOption) ?? '—'}</dd>
              {caseRow.needsHrReason ? (
                <>
                  <dt>Needs HR</dt>
                  <dd>{caseRow.needsHrReason}</dd>
                </>
              ) : null}
              {caseRow.closeReason ? (
                <>
                  <dt>Closed</dt>
                  <dd>{caseRow.closeReason}</dd>
                </>
              ) : null}
            </dl>

            <div className="btn-row" style={{ marginTop: 14 }}>
              <form action={contactNow}>
                <input type="hidden" name="caseId" value={caseRow.id} />
                <button className="btn small primary" type="submit">
                  {reminder ? (onCall ? 'Call about the action' : 'Send the reminder') : onCall ? 'Call now' : 'Send now'}
                </button>
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
                <button className="btn small" type="submit" title="Clears the conversation and makes this an unasked case again">
                  Reset case
                </button>
              </form>
            </div>
          </section>

          {calls.length ? (
            <section className="card pad">
              <div className="section-head">
                <h2>Calls</h2>
                <span className="hint">{onCall ? 'This employee is set to Call' : 'Earlier calls'}</span>
              </div>
              {calls.slice(0, 3).map((call) => (
                <div key={call.id} style={{ marginBottom: 12 }}>
                  <dl className="kv">
                    <dt>When</dt>
                    <dd>{formatTime(call.startedAt ?? call.endedAt)}</dd>
                    <dt>Status</dt>
                    <dd>
                      {call.status}
                      {call.outcome ? ` · ${call.outcome.replace(/_/g, ' ')}` : ''}
                    </dd>
                  </dl>
                  {call.transcript?.length ? (
                    <div className="chat" style={{ maxHeight: 200, marginTop: 8 }}>
                      {[...call.transcript].reverse().map((turn, index) => (
                        <div key={index} className={`bubble ${turn.role === 'agent' ? 'outbound' : 'inbound'}`}>
                          {turn.text}
                          <span className="meta">{turn.role}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}

          {actions.length ? (
            <section className="card pad">
              <div className="section-head">
                <h2>Actions</h2>
              </div>
              {actions.map((action) => (
                <dl className="kv" key={action.id} style={{ marginBottom: 10 }}>
                  <dt>Type</dt>
                  <dd>{action.type.replace(/_/g, ' ')}</dd>
                  <dt>Status</dt>
                  <dd>{action.status.replace(/_/g, ' ')}</dd>
                  {action.hrmsReference ? (
                    <>
                      <dt>HRMS reference</dt>
                      <dd>
                        <code>{action.hrmsReference}</code>
                      </dd>
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
              <div className="section-head">
                <h2>Also pending</h2>
                <span className="hint">Chained, oldest first</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {otherPending.map((row) => (
                  <li key={row.id} style={{ marginBottom: 4 }}>
                    <Link href={`/cases/${row.id}`}>{row.attDate}</Link>{' '}
                    <span className="sub">{statusDisplay(row.status).label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
