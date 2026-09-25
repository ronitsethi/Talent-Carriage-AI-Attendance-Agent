import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { availableDates, listCases } from '@/lib/queries';
import { actionLabel, caseDateLabel, formatTime, replyLabel, statusDisplay } from '@/lib/display';

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'attention', label: 'Needs HR' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; status?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer selected.</p>;

  const { date, status, q } = await searchParams;
  const [rows, dates] = await Promise.all([
    listCases(tenantId, { date, status: status ?? 'open', search: q }),
    availableDates(tenantId),
  ]);

  const query = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { date, status: status ?? 'open', q, ...next };
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
            <label htmlFor="date">Date</label>
            <select className="input" id="date" name="date" defaultValue={date ?? ''}>
              <option value="">All dates</option>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
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
              <th>Last activity</th>
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
                    <td className="nowrap sub">{formatTime(row.answeredAt ?? row.askedAt)}</td>
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
                <td className="empty" colSpan={6}>
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
