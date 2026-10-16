import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { CASE_FILTERS, DEFAULT_CASE_FILTER, caseCounts, listCases, tenantSummary } from '@/lib/queries';
import { actionLabel, caseDateLabel, formatTime, replyLabel } from '@/lib/display';
import { StatusPill } from '@/components/status-pill';
import { ConfirmSubmit } from '@/components/confirm';
import { contactNow, setCallModeFromRow, setEmployeeChannel, setEmployeeMode } from '@/app/actions';

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; from?: string; to?: string; status?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer selected.</p>;

  const { date, from, to, status, q } = await searchParams;
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

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Follow-up cases</div>
        <h1>Cases</h1>
        <p>One row is one employee and one date. Open a case to read the conversation and act on it.</p>
      </section>

      <div className="card flush">
        <form className="toolbar" method="get">
          {/* The tabs are links, so the status they chose rides along with the rest of the filter. */}
          <input type="hidden" name="status" value={current} />
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
            <input className="input" type="date" id="from" name="from" defaultValue={from ?? date ?? ''} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="to">To</label>
            <input className="input" type="date" id="to" name="to" defaultValue={to ?? date ?? ''} />
          </div>
          <div className="field" style={{ minWidth: 220, flex: 1, maxWidth: 320 }}>
            <label htmlFor="q">Employee</label>
            <input className="input" id="q" name="q" placeholder="Name or code" defaultValue={q ?? ''} />
          </div>
          <button className="btn" type="submit">
            Filter
          </button>
          <Link className="btn quiet" href="/cases">
            Reset
          </Link>
          <span className="toolbar-end toolbar-count">
            {rows.length} case{rows.length === 1 ? '' : 's'}
          </span>
        </form>

        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Absent date</th>
                <th>Status</th>
                <th>Reply → action</th>
                <th>Contact by</th>
                <th>Call style</th>
                <th>Mode</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
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
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="employee">{row.employeeName}</div>
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
                      <td style={{ maxWidth: 240 }}>
                        <StatusPill status={row.status} />
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
                              <form key={option} action={setEmployeeChannel}>
                                <input type="hidden" name="employeeId" value={row.employeeId} />
                                <input type="hidden" name="channel" value={option} />
                                <button
                                  type="submit"
                                  className={`switch-option ${row.preferredChannel === option ? 'on' : ''}`}
                                  aria-pressed={row.preferredChannel === option}
                                  title={`Contact ${row.employeeName} by ${option === 'voice' ? 'call' : 'WhatsApp'}`}
                                >
                                  {option === 'voice' ? 'Call' : 'WhatsApp'}
                                </button>
                              </form>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="nowrap">
                        {gone ? (
                          <span className="sub">—</span>
                        ) : (
                          <div
                            className={`switch-group ${row.preferredChannel === 'voice' ? '' : 'muted'}`}
                            role="group"
                            aria-label="Call style"
                          >
                            {/* Each switch is its own form on this page: the table
                                is not wrapped in one, so `formAction` has nothing to
                                submit. */}
                            {(['keypad', 'agent'] as const).map((option) => {
                              const on = (row.callMode ?? settings?.callMode ?? 'keypad') === option;
                              return (
                                <form key={option} action={setCallModeFromRow.bind(null, row.employeeId, option)}>
                                  <button
                                    type="submit"
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
                                </form>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="nowrap">
                        {gone ? null : (
                          <div className="switch-group" role="group" aria-label="Mode">
                            {(['manual', 'automatic'] as const).map((option) => {
                              const on = (row.operatingMode ?? settings?.operatingMode ?? 'manual') === option;
                              return (
                                <form key={option} action={setEmployeeMode}>
                                  <input type="hidden" name="employeeId" value={row.employeeId} />
                                  <input type="hidden" name="mode" value={option} />
                                  <button
                                    type="submit"
                                    className={`switch-option ${on ? 'on' : ''}`}
                                    aria-pressed={on}
                                    title={
                                      row.operatingMode
                                        ? 'Set for this person, whatever the customer default is'
                                        : `Following the customer default (${settings?.operatingMode ?? 'manual'})`
                                    }
                                  >
                                    {option === 'automatic' ? 'Auto' : 'Manual'}
                                  </button>
                                </form>
                              );
                            })}
                          </div>
                        )}
                        {row.answeredAt || row.askedAt ? (
                          <div className="sub">{formatTime(row.answeredAt ?? row.askedAt)}</div>
                        ) : null}
                      </td>
                      <td className="nowrap end">
                        <div className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 6 }}>
                          {!gone && ['queued', 'failed'].includes(row.status) ? (
                            <form action={contactNow}>
                              <input type="hidden" name="caseId" value={row.id} />
                              <ConfirmSubmit
                                label={row.preferredChannel === 'voice' ? 'Call now' : 'Send now'}
                                className="btn small primary"
                                title={
                                  row.preferredChannel === 'voice'
                                    ? `Call ${row.employeeName} now?`
                                    : `Message ${row.employeeName} now?`
                                }
                                message={
                                  <p>
                                    {row.preferredChannel === 'voice' ? 'Their phone rings' : 'A WhatsApp message goes out'}{' '}
                                    straight away, asking about{' '}
                                    <strong>{caseDateLabel(row.attDate, row.meaning)}</strong>. It cannot be taken back.
                                  </p>
                                }
                                confirmLabel={row.preferredChannel === 'voice' ? 'Call now' : 'Send now'}
                              />
                            </form>
                          ) : null}
                          <Link className="btn small" href={`/cases/${row.id}`}>
                            Open →
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="empty" colSpan={8}>
                    No cases match that filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
