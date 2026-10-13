import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { availableDates, dashboardStats, flaggedInRange, latestCaseDate, tenantSummary } from '@/lib/queries';
import { capabilities, env } from '@/lib/env';
import { caseDateLabel, meaningLabel } from '@/lib/display';
import { Notice } from '@/components/notice';
import { StatusPill } from '@/components/status-pill';
import {
  contactSelected,
  resetAllCases,
  runFollowUps,
  setCallModeFromRow,
  setChannelFromRow,
  setModeFromRow,
} from '@/app/actions';
import { RowCheckbox, SelectAll, SelectedCount, SelectionProvider } from './selection';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; sent?: string; blocked?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer has been set up yet.</p>;

  const [{ tenant, settings }, stats, dates, withCases, { from, to, sent, blocked }] = await Promise.all([
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
  // "Not contacted" means nobody has been asked - which includes a case that
  // exists but has never gone out, as happens when sending is switched off.
  // Judging by the case id alone left such rows unticked, so pressing Contact
  // silently skipped exactly the dates that most needed contacting.
  const awaitingContact = (row: (typeof flagged)[number]) => !row.caseId || row.caseStatus === 'queued';
  const notYetContacted = flagged.filter(awaitingContact);
  // Anyone not yet contacted starts ticked. The signature changes whenever the
  // table does, which resets the selection to those defaults.
  const selectionRows = flagged.map((row) => ({
    value: `${row.employeeId}|${row.attDate}`,
    selected: awaitingContact(row),
  }));
  const selectionKey = selectionRows.map((row) => `${row.value}:${row.selected ? 1 : 0}`).join(',');
  const caps = capabilities();

  return (
    <>
      {/* Nothing goes out at all while this is off, so it cannot be a quiet
          dot in the status bar - it is the whole product switched off. */}
      {settings && !settings.sendingEnabled ? (
        <div className="notice err plain">
          <div className="notice-body">
            <strong>Sending is switched off for {tenant?.name}.</strong> Cases are still created, but no message or call
            will go out however many times you press Contact. Turn it back on in <Link href="/settings">Settings</Link> —
            &ldquo;Allow messages to be sent at all&rdquo;.
          </div>
        </div>
      ) : null}

      {sent || blocked ? (
        <Notice tone={blocked ? 'err' : 'ok'} clear={['sent', 'blocked']}>
          {sent ? `Contacted ${sent} ${Number(sent) === 1 ? 'person' : 'people'}. ` : ''}
          {blocked ? `Nothing sent: ${blocked}.` : ''}
        </Notice>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">HR command center</div>
        <h1>{tenant?.name}</h1>
        <p style={{ maxWidth: '70ch' }}>
          Everyone absent or on half-day in these dates. Set how each person is contacted, tick the ones you want, and
          send.{' '}
          {stats.dataFrom ? `Attendance data covers ${stats.dataFrom} to ${stats.dataTo}.` : 'No attendance imported yet.'}
        </p>
      </section>

      <section className="summary-grid" aria-label="Cases at a glance">
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
      </section>

      {/*
        The date range has a form of its own, empty here: its fields sit in the
        table's toolbar, inside the contact form, and belong to this one through
        their `form` attribute - forms cannot nest, and the range must not be
        posted with the selection.
      */}
      <form id="range" method="get" />

      {/*
        One form carries the switches and the bulk action: nested forms are not
        valid HTML, so each button names its own action and its own value.
      */}
      <form action={contactSelected}>
        <SelectionProvider key={selectionKey} rows={selectionRows}>
          <div className="card flush">
            <div className="toolbar">
              <div className="field" style={{ minWidth: 160 }}>
                <label htmlFor="from">From date</label>
                <input className="input" type="date" id="from" name="from" form="range" defaultValue={rangeFrom} />
              </div>
              <div className="field" style={{ minWidth: 160 }}>
                <label htmlFor="to">To date</label>
                <input className="input" type="date" id="to" name="to" form="range" defaultValue={rangeTo} />
              </div>
              <button className="btn" type="submit" form="range">
                Show
              </button>
              <span className="toolbar-count">
                {flagged.length} flagged · {notYetContacted.length} not contacted yet
              </span>
              <div className="toolbar-end">
                <SelectedCount />
                <button className="btn primary" type="submit">
                  Contact selected
                </button>
              </div>
            </div>

            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>
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
                            <div className="sub mono">{row.mobile ? `+${row.mobile}` : 'No number'}</div>
                          </td>
                          <td>
                            <span className="code-chip">{row.rawStatus ?? row.meaning}</span>
                            <div className="sub">{meaningLabel(row.meaning)}</div>
                          </td>
                          <td>
                            {row.caseStatus ? <StatusPill status={row.caseStatus} /> : <span className="sub">Not contacted</span>}
                          </td>
                          <td className="nowrap">
                            <div className="switch-group" role="group" aria-label={`Contact ${row.employeeName} by`}>
                              {(['whatsapp', 'voice'] as const).map((option) => (
                                <button
                                  key={option}
                                  type="submit"
                                  formAction={setChannelFromRow.bind(null, row.employeeId, option)}
                                  className={`switch-option ${row.preferredChannel === option ? 'on' : ''}`}
                                  aria-pressed={row.preferredChannel === option}
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
                            <div
                              className={`switch-group ${row.preferredChannel === 'voice' ? '' : 'muted'}`}
                              role="group"
                              aria-label="Call style"
                            >
                              {(['keypad', 'agent'] as const).map((option) => {
                                const on = (row.callMode ?? settings?.callMode ?? 'keypad') === option;
                                return (
                                  <button
                                    key={option}
                                    type="submit"
                                    formAction={setCallModeFromRow.bind(null, row.employeeId, option)}
                                    className={`switch-option ${on ? 'on' : ''}`}
                                    aria-pressed={on}
                                    title={
                                      option === 'agent'
                                        ? 'A spoken conversation: they answer in their own words'
                                        : 'The agent reads the options and they press a key'
                                    }
                                  >
                                    {option === 'agent' ? 'Talk' : 'Keypad'}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                          <td className="nowrap">
                            <div className="switch-group" role="group" aria-label="Mode">
                              {(['manual', 'automatic'] as const).map((option) => {
                                // An employee with no setting of their own follows
                                // the customer's, so that is what must be shown as
                                // lit - otherwise a customer on Automatic looks as
                                // though every row is Manual.
                                const on = (row.operatingMode ?? settings?.operatingMode ?? 'manual') === option;
                                return (
                                  <button
                                    key={option}
                                    type="submit"
                                    formAction={setModeFromRow.bind(null, row.employeeId, option)}
                                    className={`switch-option ${on ? 'on' : ''}`}
                                    aria-pressed={on}
                                    title={
                                      row.operatingMode
                                        ? `Set for this person, whatever the customer default is`
                                        : `Following the customer default (${settings?.operatingMode ?? 'manual'})`
                                    }
                                  >
                                    {option === 'automatic' ? 'Auto' : 'Manual'}
                                  </button>
                                );
                              })}
                            </div>
                          </td>
                          <td className="nowrap">
                            {row.caseId ? (
                              <Link className="btn small" href={`/cases/${row.caseId}`}>
                                Open →
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
          </div>
        </SelectionProvider>
      </form>

      <div className="tiles" style={{ marginTop: 20 }}>
        <section className="card pad span-2">
          <div className="section-head">
            <h2>How the agent works</h2>
          </div>
          <div className="timeline">
            <div className="step">
              <div className="dot">01</div>
              <div className="step-title">One contact per absent date</div>
              <div className="step-copy">A WhatsApp message or a call, per the switch against that person.</div>
            </div>
            <div className="step">
              <div className="dot">02</div>
              <div className="step-title">Ignored dates simply wait</div>
              <div className="step-copy">No chasing and no repeat calls; they pile up until the employee engages.</div>
            </div>
            <div className="step">
              <div className="dot">03</div>
              <div className="step-title">One answer clears the backlog</div>
              <div className="step-copy">
                Guidance, then what is still pending, then the next date — in the same conversation or call.
              </div>
            </div>
            <div className="step">
              <div className="dot">04</div>
              <div className="step-title">Automatic chases yesterday</div>
              <div className="step-copy">
                Employees set to Auto are contacted the day after the absence, at {settings?.checkTime.slice(0, 5)} —
                change that time in <Link href="/settings">Settings</Link>, under Daily check.
              </div>
            </div>
          </div>
        </section>

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
              <button className="btn danger" type="submit">
                Reset all cases
              </button>
            </form>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
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
            <dd className="mono">{env.APP_BASE_URL}/api/webhook</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
