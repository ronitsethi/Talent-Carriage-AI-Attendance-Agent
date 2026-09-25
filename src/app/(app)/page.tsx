import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { availableDates, dashboardStats, latestCaseDate, listCases, tenantSummary } from '@/lib/queries';
import { capabilities, env } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { caseDateLabel, formatTime, statusDisplay } from '@/lib/display';
import { resetAllCases, runCheck, runFollowUps } from '@/app/actions';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; from?: string; to?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer has been set up yet.</p>;

  const [{ tenant, settings }, stats, dates, withCases, { date, from, to }] = await Promise.all([
    tenantSummary(tenantId),
    dashboardStats(tenantId),
    availableDates(tenantId),
    latestCaseDate(tenantId),
    searchParams,
  ]);

  // Default to the day that already has cases, so the dashboard opens on
  // something worth looking at rather than an empty future date.
  const selectedDate = date ?? withCases ?? dates[0] ?? new Date().toISOString().slice(0, 10);
  // The check runs over a range; a single day is simply the same date twice.
  const rangeFrom = from ?? selectedDate;
  const rangeTo = to ?? selectedDate;
  const [attention, rangeCases] = await Promise.all([
    listCases(tenantId, { status: 'attention', limit: 8 }),
    listCases(tenantId, { from: rangeFrom, to: rangeTo, status: 'all', limit: 10 }),
  ]);

  const caps = capabilities();
  const providers = models.status().filter((p) => p.available && p.provider !== 'stub');

  return (
    <>
      <section className="summary">
        <div className="summary-grid">
          <div className="stat">
            <span className="lbl">Total cases</span>
            <span className="val">{stats.total}</span>
          </div>
          <div className="stat">
            <span className="lbl">Awaiting reply</span>
            <span className="val warn">{stats.awaitingReply}</span>
          </div>
          <div className="stat">
            <span className="lbl">Answered</span>
            <span className="val">{stats.answered}</span>
          </div>
          <div className="stat">
            <span className="lbl">Resolved</span>
            <span className="val">{stats.resolved}</span>
          </div>
          <div className="stat">
            <span className="lbl">With manager</span>
            <span className="val">{stats.pendingApprovals}</span>
          </div>
          <div className="stat">
            <span className="lbl">Needs HR</span>
            <span className={`val ${stats.needsAttention ? 'danger' : ''}`}>{stats.needsAttention}</span>
          </div>
        </div>
        <div className="flags">
          <span className={`flag ${caps.dryRun ? 'warn' : 'ok'}`}>
            {caps.dryRun ? '◷ Dry run · nothing is delivered' : '✓ WhatsApp live'}
          </span>
          <span className={`flag ${settings?.sendingEnabled ? 'ok' : 'idle'}`}>
            {settings?.sendingEnabled ? '✓ Sending enabled' : 'Sending switched off'}
          </span>
          <span className={`flag ${providers.length ? 'ok' : 'idle'}`}>
            {providers.length ? `✓ AI: ${providers.map((p) => p.provider).join(', ')}` : 'AI: rules only'}
          </span>
          <span className={`flag ${settings?.actionsEnabled ? 'ok' : 'idle'}`}>
            {settings?.actionsEnabled ? '✓ Actions enabled' : 'Guidance only'}
          </span>
          <span className={`flag ${settings?.operatingMode === 'automatic' ? 'ok' : 'idle'}`}>
            {settings?.operatingMode === 'automatic'
              ? `✓ Automatic · daily check at ${settings.checkTime.slice(0, 5)}`
              : 'Manual · HR runs the check'}
          </span>
          <span className="flag idle">{stats.employees} employees</span>
        </div>
      </section>

      <section className="page-head">
        <div className="eyebrow">✦ HR Command Center</div>
        <h1>{tenant?.name}</h1>
        <p>
          Check a day&apos;s attendance, message everyone with a gap, and follow each one until it is explained.
          {stats.dataFrom ? ` Attendance data covers ${stats.dataFrom} to ${stats.dataTo}.` : ' No attendance imported yet.'}
        </p>
      </section>

      <div className="layout">
        <div>
          <section className="section">
            <div className="section-head">
              <h2>Run the attendance check</h2>
              <span className="hint">One case per employee per date · re-running never messages twice</span>
            </div>
            <div className="card">
              <form action={runCheck} className="row">
                <div className="field" style={{ minWidth: 165 }}>
                  <label htmlFor="from">From date</label>
                  <input className="input" type="date" id="from" name="from" defaultValue={rangeFrom} />
                </div>
                <div className="field" style={{ minWidth: 165 }}>
                  <label htmlFor="to">To date</label>
                  <input className="input" type="date" id="to" name="to" defaultValue={rangeTo} />
                </div>
                <button className="btn primary" type="submit">
                  Run check &amp; send
                </button>
                <Link className="btn" href={`/preview?from=${rangeFrom}&to=${rangeTo}`}>
                  Preview first
                </Link>
                <Link className="btn" href={`/cases?from=${rangeFrom}&to=${rangeTo}&status=all`}>
                  View these dates
                </Link>
              </form>
              <p className="hint" style={{ padding: '0 20px 14px' }}>
                Leave both dates the same to check one day. Re-running a range is safe: a date that already has a case
                is left alone.
              </p>
              {stats.queued ? (
                <div className="notice info" style={{ marginBottom: 14 }}>
                  {stats.queued} case{stats.queued === 1 ? '' : 's'} held back by the outstanding-question cap. Each is
                  asked as soon as an earlier date is answered.
                </div>
              ) : null}
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Needs a person</h2>
              <span className="hint">Unclear replies, rejections and failures</span>
            </div>
            <div className="card table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Date</th>
                    <th>Why</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {attention.length ? (
                    attention.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="employee">{row.employeeName}</div>
                          <div className="sub">{row.department ?? '—'}</div>
                        </td>
                        <td className="nowrap">{caseDateLabel(row.attDate, row.meaning)}</td>
                        <td>{row.needsHrReason ?? row.error ?? '—'}</td>
                        <td className="nowrap">
                          <Link className="btn small" href={`/cases/${row.id}`}>
                            Open
                          </Link>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="empty" colSpan={4}>
                        Nothing waiting on a human right now.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>{rangeFrom === rangeTo ? rangeFrom : `${rangeFrom} → ${rangeTo}`}</h2>
              <span className="hint">Cases in the selected range</span>
            </div>
            <div className="card table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Code</th>
                    <th>Status</th>
                    <th>Asked</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rangeCases.length ? (
                    rangeCases.map((row) => {
                      const display = statusDisplay(row.status);
                      return (
                        <tr key={row.id}>
                          <td>
                            <div className="employee">{row.employeeName}</div>
                            <div className="sub">
                              {row.employeeCode} · {row.attDate}
                            </div>
                          </td>
                          <td>
                            <span className="pill idle">{row.rawStatus ?? row.meaning}</span>
                          </td>
                          <td>
                            <span className={`pill ${display.tone}`}>{display.label}</span>
                          </td>
                          <td className="nowrap sub">{formatTime(row.askedAt)}</td>
                          <td className="nowrap">
                            <Link className="btn small" href={`/cases/${row.id}`}>
                              Open
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td className="empty" colSpan={5}>
                        No cases in this range. Run the check above.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside>
          <section className="card pad">
            <div className="section-head">
              <h2>Replies so far</h2>
            </div>
            <dl className="kv">
              <dt>1 · Was absent</dt>
              <dd>{stats.byOption[1] ?? 0}</dd>
              <dt>2 · Was working</dt>
              <dd>{stats.byOption[2] ?? 0}</dd>
              <dt>3 · Applied leave</dt>
              <dd>{stats.byOption[3] ?? 0}</dd>
              <dt>4 · Sent regularisation</dt>
              <dd>{stats.byOption[4] ?? 0}</dd>
              <dt>Actions in flight</dt>
              <dd>{stats.openActions}</dd>
            </dl>
            <form action={runFollowUps} style={{ marginTop: 14 }}>
              <button className="btn" type="submit">
                Send due day-{settings?.followUpAfterDays ?? 2} reminders
              </button>
            </form>
            <form action={resetAllCases} style={{ marginTop: 8 }}>
              <button className="btn" type="submit">
                Reset all cases
              </button>
              <p className="hint" style={{ marginTop: 6 }}>
                Clears every case and conversation for this customer. Employees and attendance stay.
              </p>
            </form>
          </section>

          <section className="card pad">
            <div className="section-head">
              <h2>How the agent works</h2>
            </div>
            <div className="timeline">
              <div className="step">
                <div className="dot">1</div>
                <div>
                  <div className="step-title">One question per absent date</div>
                  <div className="step-copy">Sent as each gap is found, in the employee&apos;s language.</div>
                </div>
              </div>
              <div className="step">
                <div className="dot">2</div>
                <div>
                  <div className="step-title">Unanswered dates simply wait</div>
                  <div className="step-copy">No reminders, so questions pile up until the employee engages.</div>
                </div>
              </div>
              <div className="step">
                <div className="dot">3</div>
                <div>
                  <div className="step-title">One answer moves the chain</div>
                  <div className="step-copy">
                    Guidance, then a summary of what is left and the next date — in the same conversation.
                  </div>
                </div>
              </div>
              <div className="step">
                <div className="dot">4</div>
                <div>
                  <div className="step-title">Then the agent acts</div>
                  <div className="step-copy">
                    Leave or regularisation applied in the HRMS once the manager approves.
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="card pad">
            <div className="section-head">
              <h2>Connections</h2>
            </div>
            <dl className="kv">
              <dt>WhatsApp</dt>
              <dd>{caps.whatsapp ? 'Meta Cloud API' : 'Simulator'}</dd>
              <dt>HRMS</dt>
              <dd>{caps.hrms}</dd>
              <dt>Voice</dt>
              <dd>{caps.voice}</dd>
              <dt>Webhook</dt>
              <dd>
                <code>{env.APP_BASE_URL}/api/webhook</code>
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
