import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { availableDates, listCases, tenantSummary } from '@/lib/queries';
import { actionLabel, caseDateLabel, formatTime, replyLabel, statusDisplay } from '@/lib/display';
import { contactNow, setCallModeFromRow, setEmployeeChannel, setEmployeeMode } from '@/app/actions';

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'attention', label: 'Needs HR' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

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
  const [rows, dates, { settings }] = await Promise.all([
    listCases(tenantId, { date, from, to, status: status ?? 'open', search: q }),
    availableDates(tenantId),
    tenantSummary(tenantId),
  ]);

  const query = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { from, to, status: status ?? 'open', q, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    return `/cases?${params.toString()}`;
  };

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">☑ Follow-up cases</div>
        <h1>Cases</h1>
        <p>One row is one employee and one date. Open a case to read the conversation and act on it.</p>
      </section>

      <div className="card" style={{ marginTop: 18 }}>
        <form className="row" method="get">
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="from">From</label>
            <input className="input" type="date" id="from" name="from" defaultValue={from ?? date ?? ''} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="to">To</label>
            <input className="input" type="date" id="to" name="to" defaultValue={to ?? date ?? ''} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="status">Status</label>
            <select className="input" id="status" name="status" defaultValue={status ?? 'open'}>
              {FILTERS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor="q">Employee</label>
            <input className="input" id="q" name="q" placeholder="Name or code" defaultValue={q ?? ''} />
          </div>
          <button className="btn primary" type="submit">
            Filter
          </button>
          <Link className="btn" href="/cases">
            Reset
          </Link>
        </form>
      </div>

      <div className="section-head" style={{ marginTop: 22 }}>
        <h2>{rows.length} case{rows.length === 1 ? '' : 's'}</h2>
        <span className="hint">
          {FILTERS.map((f) => (
            <Link key={f.key} href={query({ status: f.key })} style={{ marginLeft: 10 }}>
              {f.label}
            </Link>
          ))}
        </span>
      </div>

      <div className="card table-scroll">
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
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => {
                const display = statusDisplay(row.status);
                const reply = replyLabel(row.replyOption);
                return (
                  <tr key={row.id}>
                    <td>
                      <div className="employee">{row.employeeName}</div>
                      <div className="sub">
                        {row.employeeCode} · {row.department ?? '—'}
                      </div>
                    </td>
                    <td className="nowrap">
                      {caseDateLabel(row.attDate, row.meaning)}
                      <div className="sub">
                        <span className="pill idle">{row.rawStatus ?? row.meaning}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${display.tone}`}>{display.label}</span>
                      {row.needsHrReason ? <div className="sub">{row.needsHrReason}</div> : null}
                    </td>
                    <td>
                      {reply ? (
                        <>
                          {reply}
                          {row.aiUsed ? <span className="pill waiting" style={{ marginLeft: 6 }}>AI</span> : null}
                          <div className="sub">→ {actionLabel(row.replyOption)}</div>
                        </>
                      ) : (
                        <span className="sub">—</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <div className="switch-group">
                        {(['whatsapp', 'voice'] as const).map((option) => (
                          <form key={option} action={setEmployeeChannel}>
                            <input type="hidden" name="employeeId" value={row.employeeId} />
                            <input type="hidden" name="channel" value={option} />
                            <button
                              type="submit"
                              className={`switch-option ${row.preferredChannel === option ? 'on' : ''}`}
                              title={`Contact ${row.employeeName} by ${option === 'voice' ? 'call' : 'WhatsApp'}`}
                            >
                              {option === 'voice' ? 'Call' : 'WhatsApp'}
                            </button>
                          </form>
                        ))}
                      </div>
                    </td>
                    <td className="nowrap">
                      <div className={`switch-group ${row.preferredChannel === 'voice' ? '' : 'muted'}`}>
                        {/* Each switch is its own form on this page: the table
                            is not wrapped in one, so `formAction` has nothing to
                            submit. */}
                        {(['keypad', 'agent'] as const).map((option) => (
                          <form key={option} action={setCallModeFromRow.bind(null, row.employeeId, option)}>
                            <button
                              type="submit"
                              className={`switch-option ${
                                (row.callMode ?? settings?.callMode ?? 'keypad') === option ? 'on' : ''
                              }`}
                              title={
                                option === 'agent'
                                  ? 'A spoken conversation: they answer in their own words'
                                  : 'The agent reads the options and they press a key'
                              }
                            >
                              {option === 'agent' ? 'Talk' : 'Keypad'}
                            </button>
                          </form>
                        ))}
                      </div>
                    </td>
                    <td className="nowrap">
                      <div className="switch-group">
                        {(['manual', 'automatic'] as const).map((option) => (
                          <form key={option} action={setEmployeeMode}>
                            <input type="hidden" name="employeeId" value={row.employeeId} />
                            <input type="hidden" name="mode" value={option} />
                            <button
                              type="submit"
                              className={`switch-option ${
                                (row.operatingMode ?? settings?.operatingMode ?? 'manual') === option ? 'on' : ''
                              }`}
                              title={
                                row.operatingMode
                                  ? 'Set for this person, whatever the customer default is'
                                  : `Following the customer default (${settings?.operatingMode ?? 'manual'})`
                              }
                            >
                              {option === 'automatic' ? 'Auto' : 'Manual'}
                            </button>
                          </form>
                        ))}
                      </div>
                      {row.answeredAt || row.askedAt ? (
                        <div className="sub">{formatTime(row.answeredAt ?? row.askedAt)}</div>
                      ) : null}
                    </td>
                    <td className="nowrap">
                      <div className="btn-row">
                        {['queued', 'failed'].includes(row.status) ? (
                          <form action={contactNow}>
                            <input type="hidden" name="caseId" value={row.id} />
                            <button className="btn small primary" type="submit">
                              {row.preferredChannel === 'voice' ? 'Call now' : 'Send now'}
                            </button>
                          </form>
                        ) : null}
                        <Link className="btn small" href={`/cases/${row.id}`}>
                          Open
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
    </>
  );
}
