import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { CASE_FILTERS, DEFAULT_CASE_FILTER, caseCounts, listCases, tenantSummary } from '@/lib/queries';
import { actionLabel, caseDateLabel, caseStatus, followUpLabel, formatTime, replyLabel } from '@/lib/display';
import { StatusPill } from '@/components/status-pill';
import { Notice } from '@/components/notice';
import { Toast } from '@/components/toast';
import { RowLink } from '@/components/row-link';
import { contactSelectedCases, setCallModeFromRow, setChannelFromRow, setModeFromRow } from '@/app/actions';
import { ContactSelected, RowCheckbox, RowSwitch, SelectAll, SelectionProvider } from '../selection';

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; from?: string; to?: string; status?: string; q?: string; sent?: string; blocked?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer selected.</p>;

  const { date, from, to, status, q, sent, blocked } = await searchParams;
  // One unknown value in the URL should not empty the table.
  const current = CASE_FILTERS.some((f) => f.key === status) ? status! : DEFAULT_CASE_FILTER;
  const [rows, counts, { settings }] = await Promise.all([
    listCases(tenantId, { date, from, to, status: current, search: q }),
    caseCounts(tenantId, { date, from, to, search: q }),
    tenantSummary(tenantId),
  ]);

  const query = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { from, to, status: current, q, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    return `/cases?${params.toString()}`;
  };

  // As on the dashboard, nothing starts ticked. A deleted employee's case is a
  // record only, so it cannot be ticked at all. The value carries the employee
  // first, which is how the confirmation counts people rather than dates.
  const selectionRows = rows
    .filter((row) => !row.employeeDeletedAt)
    .map((row) => ({ value: `${row.employeeId}|${row.id}`, selected: false }));
  const selectionKey = selectionRows.map((row) => row.value).join(',');

  return (
    <>
      {blocked ? (
        <Notice tone="err" clear={['sent', 'blocked']}>
          {sent ? `Contacted ${sent} ${Number(sent) === 1 ? 'time' : 'times'}. ` : ''}
          Nothing sent: {blocked}.
        </Notice>
      ) : sent ? (
        <Toast clear={['sent']}>
          Contacted {sent} {Number(sent) === 1 ? 'time' : 'times'}.
        </Toast>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">Follow-up cases</div>
        <h1>Cases</h1>
        <p>One row is one employee and one date. Click a row to read the conversation and act on it.</p>
      </section>

      {/* The filters have a form of their own, empty here: its fields sit in the
          table's toolbar, inside the contact form, and belong to this one through
          their `form` attribute - forms cannot nest. */}
      <form id="case-filters" method="get">
        <input type="hidden" name="status" value={current} />
      </form>

      <form action={contactSelectedCases}>
        <input type="hidden" name="back" value={query({})} />
        <SelectionProvider key={selectionKey} signature={selectionKey} rows={selectionRows}>
          <div className="card flush">
            <div className="toolbar">
              {/* A line of their own: eight states and three fields on one row
                  leaves the tabs wrapping mid-group. */}
              <div style={{ flexBasis: '100%' }}>
                <nav className="switch-group wrap" aria-label="Status">
                  {CASE_FILTERS.map((f) => (
                    <Link
                      key={f.key}
                      href={query({ status: f.key })}
                      className={`switch-option ${current === f.key ? 'on' : ''}`}
                      aria-current={current === f.key ? 'page' : undefined}
                    >
                      {f.label} <span className="count">{counts[f.key]}</span>
                    </Link>
                  ))}
                </nav>
              </div>
              <div className="field" style={{ minWidth: 150 }}>
                <label htmlFor="from">From</label>
                <input className="input" type="date" id="from" name="from" form="case-filters" defaultValue={from ?? date ?? ''} />
              </div>
              <div className="field" style={{ minWidth: 150 }}>
                <label htmlFor="to">To</label>
                <input className="input" type="date" id="to" name="to" form="case-filters" defaultValue={to ?? date ?? ''} />
              </div>
              <div className="field" style={{ minWidth: 220, flex: 1, maxWidth: 320 }}>
                <label htmlFor="q">Employee</label>
                <input className="input" id="q" name="q" form="case-filters" placeholder="Name or code" defaultValue={q ?? ''} />
              </div>
              <button className="btn" type="submit" form="case-filters">
                Filter
              </button>
              <Link className="btn quiet" href="/cases">
                Reset
              </Link>
              <span className="toolbar-count">
                {rows.length} case{rows.length === 1 ? '' : 's'}
              </span>
              <div className="toolbar-end">
                <ContactSelected />
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
                    <th>Absent date</th>
                    <th>Asked</th>
                    <th>Follow-up</th>
                    <th>Last contact</th>
                    <th>Status</th>
                    <th>Reply → action</th>
                    <th>Contact by</th>
                    <th>Call style</th>
                    <th>Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? (
                    rows.map((row) => {
                      const reply = replyLabel(row.replyOption);
                      // Their employee is deleted: the case is readable and nothing
                      // else. Every control that would act on it is gone, and the
                      // server actions refuse it as well.
                      const gone = Boolean(row.employeeDeletedAt);
                      const onCall = row.preferredChannel === 'voice';
                      return (
                        <RowLink key={row.id} href={`/cases/${row.id}`}>
                          <td className="row-control">{gone ? null : <RowCheckbox value={`${row.employeeId}|${row.id}`} />}</td>
                          <td>
                            <Link className="employee row-title" href={`/cases/${row.id}`}>
                              {row.employeeName}
                            </Link>
                            <div className="sub">
                              {row.employeeCode} · {row.department ?? '—'}
                            </div>
                            {gone ? (
                              <div style={{ marginTop: 4 }}>
                                <span
                                  className="chip neutral"
                                  title="Deleted by HR. Kept as a record until an attendance import brings them back."
                                >
                                  Deleted · record only
                                </span>
                              </div>
                            ) : null}
                          </td>
                          <td className="nowrap">
                            {caseDateLabel(row.attDate, row.meaning)}
                            <div className="sub">
                              <span className="code-chip">{row.rawStatus ?? row.meaning}</span>
                            </div>
                          </td>
                          <td className="nowrap">{row.askedAt ? formatTime(row.askedAt) : <span className="sub">Not yet</span>}</td>
                          <td className="nowrap">
                            {(() => {
                              const followUp = followUpLabel(row);
                              return followUp ? (
                                <>
                                  {followUp.when}
                                  <div className="sub">{followUp.note}</div>
                                </>
                              ) : (
                                <span className="sub">—</span>
                              );
                            })()}
                          </td>
                          <td className="nowrap">
                            {row.lastContactAt ? formatTime(row.lastContactAt) : <span className="sub">—</span>}
                          </td>
                          <td style={{ maxWidth: 240 }}>
                            <StatusPill status={caseStatus(row)} />
                            {row.needsHrReason ? <div className="sub">{row.needsHrReason}</div> : null}
                          </td>
                          <td>
                            {reply ? (
                              <>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {reply}
                                  {row.aiUsed ? <span className="chip info mono">AI</span> : null}
                                </div>
                                <div className="sub">→ {actionLabel(row.replyOption)}</div>
                              </>
                            ) : (
                              <span className="sub">—</span>
                            )}
                          </td>
                          <td className="nowrap">
                            {gone ? (
                              <span className="sub">{row.channel === 'voice' ? 'Call' : 'WhatsApp'}</span>
                            ) : (
                              <div className="switch-group" role="group" aria-label={`Contact ${row.employeeName} by`}>
                                {(['whatsapp', 'voice'] as const).map((option) => (
                                  <RowSwitch
                                    key={option}
                                    action={setChannelFromRow.bind(null, row.employeeId, option)}
                                    on={row.preferredChannel === option}
                                    title={`Contact ${row.employeeName} by ${option === 'voice' ? 'call' : 'WhatsApp'}`}
                                  >
                                    {option === 'voice' ? 'Call' : 'WhatsApp'}
                                  </RowSwitch>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="nowrap">
                            {gone ? (
                              <span className="sub">—</span>
                            ) : (
                              // Only meaningful for someone on Call: on WhatsApp it is
                              // greyed out and cannot be pressed, as on the dashboard.
                              <div
                                className={`switch-group ${onCall ? '' : 'muted'}`}
                                role="group"
                                aria-label="Call style"
                                aria-disabled={!onCall}
                              >
                                {(['keypad', 'agent'] as const).map((option) => (
                                  <RowSwitch
                                    key={option}
                                    action={setCallModeFromRow.bind(null, row.employeeId, option)}
                                    on={(row.callMode ?? settings?.callMode ?? 'keypad') === option}
                                    disabled={!onCall}
                                    title={
                                      !onCall
                                        ? `${row.employeeName} is contacted on WhatsApp — switch them to Call to choose a call style`
                                        : option === 'agent'
                                          ? 'A spoken conversation: they answer in their own words'
                                          : 'The agent reads the options and they press a key'
                                    }
                                  >
                                    {option === 'agent' ? 'Talk' : 'Keypad'}
                                  </RowSwitch>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="nowrap">
                            {gone ? null : (
                              <div className="switch-group" role="group" aria-label="Mode">
                                {(['manual', 'automatic'] as const).map((option) => (
                                  <RowSwitch
                                    key={option}
                                    action={setModeFromRow.bind(null, row.employeeId, option)}
                                    on={(row.operatingMode ?? settings?.operatingMode ?? 'manual') === option}
                                    title={
                                      row.operatingMode
                                        ? 'Set for this person, whatever the customer default is'
                                        : `Following the customer default (${settings?.operatingMode ?? 'manual'})`
                                    }
                                  >
                                    {option === 'automatic' ? 'Auto' : 'Manual'}
                                  </RowSwitch>
                                ))}
                              </div>
                            )}
                          </td>
                        </RowLink>
                      );
                    })
                  ) : (
                    <tr>
                      <td className="empty" colSpan={11}>
                        No cases match that filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </SelectionProvider>
      </form>
    </>
  );
}
