import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { listQueries } from '@/lib/queries';
import { feedbackLabel, formatTime } from '@/lib/display';
import { RowLink } from '@/components/row-link';

export default async function QueriesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer selected.</p>;

  const { from, to, q } = await searchParams;
  const rows = await listQueries(tenantId, { from, to, search: q });

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Queries</div>
        <h1>Queries</h1>
        <p>
          What employees asked of their own accord — a call to us, or a WhatsApp message that is not about an absent
          date. A call is one query; a chat is one until it has been quiet for half an hour. Click a row to read it.
        </p>
      </section>

      <div className="card flush">
        <form className="toolbar" method="get">
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="from">From</label>
            <input className="input" type="date" id="from" name="from" defaultValue={from ?? ''} />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="to">To</label>
            <input className="input" type="date" id="to" name="to" defaultValue={to ?? ''} />
          </div>
          <div className="field" style={{ minWidth: 220, flex: 1, maxWidth: 320 }}>
            <label htmlFor="q">Employee</label>
            <input className="input" id="q" name="q" placeholder="Name or code" defaultValue={q ?? ''} />
          </div>
          <button className="btn" type="submit">
            Filter
          </button>
          <Link className="btn quiet" href="/queries">
            Reset
          </Link>
          <span className="toolbar-end toolbar-count">
            {rows.length} quer{rows.length === 1 ? 'y' : 'ies'}
          </span>
        </form>

        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Date &amp; time</th>
                <th>Contact by</th>
                <th>Call style</th>
                <th>Feedback</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => {
                  const onCall = row.channel === 'voice';
                  return (
                    <RowLink key={row.id} href={`/queries/${row.id}`}>
                      <td>
                        <Link className="employee row-title" href={`/queries/${row.id}`}>
                          {row.employeeName}
                        </Link>
                        <div className="sub">
                          {row.employeeCode} · {row.department ?? '—'}
                        </div>
                      </td>
                      <td className="nowrap">{formatTime(row.startedAt)}</td>
                      <td className="nowrap">{onCall ? 'Call' : 'WhatsApp'}</td>
                      <td className="nowrap">
                        {onCall ? (
                          row.callStyle === 'keypad' ? 'Keypad' : 'Talk'
                        ) : (
                          <span className="sub" title="A WhatsApp chat has no call style">
                            —
                          </span>
                        )}
                      </td>
                      <td>
                        {(() => {
                          const feedback = feedbackLabel(row);
                          if (!feedback) return <span className="sub">—</span>;
                          return (
                            <>
                              {feedback.summary}
                              {feedback.comment ? <div className="sub feedback-comment">“{feedback.comment}”</div> : null}
                            </>
                          );
                        })()}
                      </td>
                    </RowLink>
                  );
                })
              ) : (
                <tr>
                  <td className="empty" colSpan={5}>
                    {q || from || to ? 'No queries match that filter.' : 'No queries yet.'}
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
