import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { availableDates, dashboardStats, flaggedInRange, latestCaseDate, tenantSummary } from '@/lib/queries';
import { capabilities, env } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { caseDateLabel, meaningLabel, statusDisplay } from '@/lib/display';
import {
  contactSelected,
  resetAllCases,
  runFollowUps,
  setCallModeFromRow,
  setChannelFromRow,
  setModeFromRow,
} from '@/app/actions';
import { RowCheckbox, SelectAll, SelectionProvider } from './selection';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer has been set up yet.</p>;

  const [{ tenant, settings }, stats, dates, withCases, { from, to }] = await Promise.all([
    tenantSummary(tenantId),
    dashboardStats(tenantId),
    availableDates(tenantId),
    latestCaseDate(tenantId),
    searchParams,
  ]);

  // Open on whatever has data, rather than an empty future date.
  const latest = withCases ?? dates[0] ?? new Date().toISOString().slice(0, 10);
  const rangeFrom = from ?? latest;
  const rangeTo = to ?? latest;

  const flagged = await flaggedInRange(tenantId, rangeFrom, rangeTo);
  const notYetContacted = flagged.filter((row) => !row.caseId);
  // Anyone not yet contacted starts ticked. The signature changes whenever the
  // table does, which resets the selection to those defaults.
  const selectionRows = flagged.map((row) => ({
    value: `${row.employeeId}|${row.attDate}`,
    selected: !row.caseId,
  }));
  const selectionKey = selectionRows.map((row) => `${row.value}:${row.selected ? 1 : 0}`).join(',');
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
            <span className="lbl">Needs HR</span>
            <span className={`val ${stats.needsAttention ? 'danger' : ''}`}>{stats.needsAttention}</span>
          </div>
          <div className="stat">
            <span className="lbl">Employees</span>
            <span className="val">{stats.employees}</span>
          </div>
        </div>
        <div className="flags">
          <span className={`flag ${caps.dryRun ? 'warn' : 'ok'}`}>
            {caps.dryRun ? '◷ Dry run · nothing is delivered' : '✓ Live · messages and calls go out'}
          </span>
          <span className={`flag ${settings?.sendingEnabled ? 'ok' : 'idle'}`}>
            {settings?.sendingEnabled ? '✓ Sending enabled' : 'Sending switched off'}
          </span>
          <span className={`flag ${providers.length ? 'ok' : 'idle'}`}>
            {providers.length ? `✓ AI: ${providers.map((p) => p.provider).join(', ')}` : 'AI: rules only'}
          </span>
          <span className={`flag ${settings?.operatingMode === 'automatic' ? 'ok' : 'idle'}`}>
            {settings?.operatingMode === 'automatic'
              ? `✓ Automatic at ${settings.checkTime.slice(0, 5)} · except rows set to Manual`
              : 'Manual · nothing goes out on its own, whatever the rows say'}
          </span>
          <span className="flag idle">Calls from {settings?.callerId ?? 'no number set'}</span>
        </div>
      </section>

      <section className="page-head">
        <div className="eyebrow">✦ HR Command Center</div>
        <h1>{tenant?.name}</h1>
        <p>
          Everyone absent or on half-day in these dates. Set how each person is contacted, tick the ones you want, and
          send.{' '}
          {stats.dataFrom ? `Attendance data covers ${stats.dataFrom} to ${stats.dataTo}.` : 'No attendance imported yet.'}
        </p>
      </section>

      <div className="card" style={{ marginTop: 16 }}>
        <form className="row" method="get">
          <div className="field" style={{ minWidth: 165 }}>
            <label htmlFor="from">From date</label>
            <input className="input" type="date" id="from" name="from" defaultValue={rangeFrom} />
          </div>
          <div className="field" style={{ minWidth: 165 }}>
            <label htmlFor="to">To date</label>
            <input className="input" type="date" id="to" name="to" defaultValue={rangeTo} />
          </div>
          <button className="btn" type="submit">
            Show
          </button>
          <span className="hint" style={{ alignSelf: 'center' }}>
            {flagged.length} flagged · {notYetContacted.length} not contacted yet
          </span>
        </form>
      </div>

      {/*
        One form carries the switches and the bulk action: nested forms are not
        valid HTML, so each button names its own action and its own value.
      */}
      <form action={contactSelected}>
        <SelectionProvider key={selectionKey} rows={selectionRows}>
        <div className="section-head" style={{ marginTop: 22 }}>
          <h2>{rangeFrom === rangeTo ? rangeFrom : `${rangeFrom} → ${rangeTo}`}</h2>
          <button className="btn primary" type="submit">
            Contact selected
          </button>
        </div>

        <div className="card table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <SelectAll />
                </th>
                <th>Employee</th>
                <th>Date</th>
                <th>Attendance</th>
                <th>Status</th>
                <th>Contact by</th>
                <th>Call style</th>
                <th>Mode</th>
                <th>Case</th>
              </tr>
            </thead>
            <tbody>
              {flagged.length ? (
                flagged.map((row) => {
                  const display = row.caseStatus ? statusDisplay(row.caseStatus) : null;
                  const key = `${row.employeeId}|${row.attDate}`;
                  return (
                    <tr key={key}>
                      <td>
                        {/* Already-contacted dates start unticked, so pressing
                            Contact never repeats a message or a call. */}
                        <RowCheckbox value={key} />
                      </td>
                      <td>
                        <div className="employee">{row.employeeName}</div>
                        <div className="sub">
                          {row.employeeCode} · {row.department ?? '—'}
                        </div>
                      </td>
                      <td className="nowrap">
                        {caseDateLabel(row.attDate, row.meaning)}
                        <div className="sub">{row.mobile ? `+${row.mobile}` : 'No number'}</div>
                      </td>
                      <td>
                        <span className="pill idle">{row.rawStatus ?? row.meaning}</span>
                        <div className="sub">{meaningLabel(row.meaning)}</div>
                      </td>
                      <td>
                        {display ? (
                          <span className={`pill ${display.tone}`}>{display.label}</span>
                        ) : (
                          <span className="sub">Not contacted</span>
                        )}
                      </td>
                      <td className="nowrap">
                        <div className="switch-group">
                          {(['whatsapp', 'voice'] as const).map((option) => (
                            <button
                              key={option}
                              type="submit"
                              formAction={setChannelFromRow.bind(null, row.employeeId, option)}
                              className={`switch-option ${row.preferredChannel === option ? 'on' : ''}`}
                            >
                              {option === 'voice' ? 'Call' : 'WhatsApp'}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="nowrap">
                        {/* Only meaningful for someone on Call, so it is shown
                            greyed out rather than hidden - the column stays
                            readable as people are switched between channels. */}
                        <div className={`switch-group ${row.preferredChannel === 'voice' ? '' : 'muted'}`}>
                          {(['keypad', 'agent'] as const).map((option) => (
                            <button
                              key={option}
                              type="submit"
                              formAction={setCallModeFromRow.bind(null, row.employeeId, option)}
                              className={`switch-option ${(row.callMode ?? settings?.callMode ?? 'keypad') === option ? 'on' : ''}`}
                              title={
                                option === 'agent'
                                  ? 'A spoken conversation: they answer in their own words'
                                  : 'The agent reads the options and they press a key'
                              }
                            >
                              {option === 'agent' ? 'Talk' : 'Keypad'}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="nowrap">
                        <div className="switch-group">
                          {(['manual', 'automatic'] as const).map((option) => (
                            <button
                              key={option}
                              type="submit"
                              formAction={setModeFromRow.bind(null, row.employeeId, option)}
                              // An employee with no setting of their own follows
                              // the customer's, so that is what must be shown as
                              // lit - otherwise a customer on Automatic looks as
                              // though every row is Manual.
                              className={`switch-option ${
                                (row.operatingMode ?? settings?.operatingMode ?? 'manual') === option ? 'on' : ''
                              }`}
                              title={
                                row.operatingMode
                                  ? `Set for this person, whatever the customer default is`
                                  : `Following the customer default (${settings?.operatingMode ?? 'manual'})`
                              }
                            >
                              {option === 'automatic' ? 'Auto' : 'Manual'}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="nowrap">
                        {row.caseId ? (
                          <Link className="btn small" href={`/cases/${row.caseId}`}>
                            Open
                          </Link>
                        ) : (
                          // No case exists until this person is contacted about
                          // this date, so there is nothing to open yet.
                          <span className="sub" title="A case is created when you contact them">
                            Not started
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="empty" colSpan={9}>
                    Nobody is absent or on half-day in these dates.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </SelectionProvider>
      </form>

      <div className="layout" style={{ marginTop: 22 }}>
        <div>
          <section className="card pad">
            <div className="section-head">
              <h2>How the agent works</h2>
            </div>
            <div className="timeline">
              <div className="step">
                <div className="dot">1</div>
                <div>
                  <div className="step-title">One contact per absent date</div>
                  <div className="step-copy">A WhatsApp message or a call, per the switch against that person.</div>
                </div>
              </div>
              <div className="step">
                <div className="dot">2</div>
                <div>
                  <div className="step-title">Ignored dates simply wait</div>
                  <div className="step-copy">No chasing and no repeat calls; they pile up until the employee engages.</div>
                </div>
              </div>
              <div className="step">
                <div className="dot">3</div>
                <div>
                  <div className="step-title">One answer clears the backlog</div>
                  <div className="step-copy">
                    Guidance, then what is still pending, then the next date — in the same conversation or call.
                  </div>
                </div>
              </div>
              <div className="step">
                <div className="dot">4</div>
                <div>
                  <div className="step-title">Automatic chases yesterday</div>
                  <div className="step-copy">
                    Employees set to Auto are contacted the day after the absence, at{' '}
                    {settings?.checkTime.slice(0, 5)} — change that time in <Link href="/settings">Settings</Link>,
                    under Daily check.
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside>
          <section className="card pad">
            <div className="section-head">
              <h2>Housekeeping</h2>
            </div>
            <div className="btn-row">
              <form action={runFollowUps}>
                <button className="btn" type="submit">
                  Send due day-{settings?.followUpAfterDays ?? 2} reminders
                </button>
              </form>
              <form action={resetAllCases}>
                <button className="btn" type="submit">
                  Reset all cases
                </button>
              </form>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Resetting clears every case and conversation for this customer. Employees and attendance stay.
            </p>
          </section>

          <section className="card pad">
            <div className="section-head">
              <h2>Connections</h2>
            </div>
            <dl className="kv">
              <dt>WhatsApp</dt>
              <dd>{caps.whatsapp && !caps.dryRun ? 'Meta Cloud API' : 'Simulator'}</dd>
              <dt>Calls</dt>
              <dd>{caps.voice === 'plivo' && !caps.dryRun ? 'Plivo' : 'Simulator'}</dd>
              <dt>Conversation</dt>
              <dd>{caps.voiceAgent ? 'LiveKit' : 'Not configured · keypad only'}</dd>
              <dt>Attendance data</dt>
              <dd>CSV or Excel import</dd>
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
