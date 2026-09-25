import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { caseDetail } from '@/lib/queries';
import { actionLabel, caseDateLabel, formatTime, meaningLabel, replyLabel, statusDisplay } from '@/lib/display';
import { OPTIONS, OPTION_NUMBERS } from '@/lib/conversation/flow';
import { env } from '@/lib/env';
import { closeCase, flagForHr, resetCase, simulateReply } from '@/app/actions';

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { id } = await params;
  const detail = await caseDetail(tenantId, id);
  if (!detail) notFound();

  const { caseRow, employee, transcript, actions, approvals, manager, otherPending } = detail;
  const display = statusDisplay(caseRow.status);
  const label = caseDateLabel(caseRow.attDate, caseRow.meaning);
  const answered = Boolean(caseRow.answeredAt);
  const pendingApproval = approvals.find((a) => a.decision === 'pending');

  return (
    <>
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
              <span className="hint">{employee.mobileE164 ? `+${employee.mobileE164}` : 'No number on record'}</span>
            </div>
            <div className="chat">
              {/* Reversed inside a column-reverse box: reads in order, opens at the newest. */}
              {transcript.length ? (
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

            {env.DRY_RUN ? (
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
