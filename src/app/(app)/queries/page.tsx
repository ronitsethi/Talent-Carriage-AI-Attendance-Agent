import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { listQueries, type QueryListItem, type QueryView } from '@/lib/queries';
import { feedbackLabel, formatTime } from '@/lib/display';
import { ticketLabel } from '@/lib/tickets';
import { closeTickets } from '@/app/actions';
import { RowLink } from '@/components/row-link';
import { Toast } from '@/components/toast';
import { CloseSelectedTickets, RowCheckbox, SelectAll, SelectionProvider } from '../selection';

const PRIORITY: Record<string, { label: string; tone: string }> = {
  urgent: { label: 'Urgent', tone: 'err' },
  high: { label: 'High', tone: 'warn' },
  medium: { label: 'Medium', tone: 'info' },
  low: { label: 'Low', tone: 'neutral' },
};

function Employee({ row }: { row: QueryListItem }) {
  return (
    <td>
      <Link className="employee row-title" href={`/queries/${row.id}`}>
        {row.employeeName}
      </Link>
      <div className="sub">
        {row.employeeCode} · {row.department ?? '—'}
      </div>
    </td>
  );
}

function Feedback({ row }: { row: QueryListItem }) {
  const feedback = feedbackLabel(row);
  if (!feedback) return <td><span className="sub">—</span></td>;
  return (
    <td>
      {feedback.summary}
      {feedback.comment ? <div className="sub feedback-comment">“{feedback.comment}”</div> : null}
    </td>
  );
}

export default async function QueriesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; q?: string; view?: string; closed?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer selected.</p>;

  const { from, to, q, view: asked, closed } = await searchParams;
  const view: QueryView = asked === 'tickets' ? 'tickets' : 'queries';
  const { rows, counts } = await listQueries(tenantId, { from, to, search: q, view });

  const link = (next: QueryView) => {
    const params = new URLSearchParams();
    if (next === 'tickets') params.set('view', 'tickets');
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (q) params.set('q', q);
    const text = params.toString();
    return text ? `/queries?${text}` : '/queries';
  };
  const filtered = Boolean(q || from || to);

  // Only an open ticket can be ticked: a resolved one has nothing left to close.
  const selectionRows = view === 'tickets' ? rows.filter((row) => row.ticketStatus === 'open').map((row) => ({ value: row.id, selected: false })) : [];
  const selectionKey = `${view}:${selectionRows.map((row) => row.value).join(',')}`;

  const toolbar = (
    <div className="toolbar">
      <div style={{ flexBasis: '100%' }}>
        <nav className="switch-group" aria-label="Queries or tickets">
          {(['queries', 'tickets'] as const).map((key) => (
            <Link
              key={key}
              href={link(key)}
              className={`switch-option ${view === key ? 'on' : ''}`}
              aria-current={view === key ? 'page' : undefined}
            >
              {key === 'queries' ? 'Queries' : 'Tickets'} <span className="count">{counts[key]}</span>
            </Link>
          ))}
        </nav>
      </div>
      <div className="field" style={{ minWidth: 150 }}>
        <label htmlFor="from">From</label>
        <input className="input" type="date" id="from" name="from" form="query-filters" defaultValue={from ?? ''} />
      </div>
      <div className="field" style={{ minWidth: 150 }}>
        <label htmlFor="to">To</label>
        <input className="input" type="date" id="to" name="to" form="query-filters" defaultValue={to ?? ''} />
      </div>
      <div className="field" style={{ minWidth: 220, flex: 1, maxWidth: 320 }}>
        <label htmlFor="q">Employee</label>
        <input className="input" id="q" name="q" form="query-filters" placeholder="Name or code" defaultValue={q ?? ''} />
      </div>
      <button className="btn" type="submit" form="query-filters">
        Filter
      </button>
      <Link className="btn quiet" href={view === 'tickets' ? '/queries?view=tickets' : '/queries'}>
        Reset
      </Link>
      <span className="toolbar-count">
        {view === 'tickets' ? `${rows.length} ticket${rows.length === 1 ? '' : 's'}` : `${rows.length} quer${rows.length === 1 ? 'y' : 'ies'}`}
      </span>
      {view === 'tickets' ? (
        <div className="toolbar-end">
          <CloseSelectedTickets />
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      {closed ? (
        <Toast clear={['closed']}>
          {Number(closed) === 1 ? '1 ticket closed' : `${closed} tickets closed`}; the employees are being told on WhatsApp.
        </Toast>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">Queries</div>
        <h1>Queries</h1>
        <p>
          What employees asked of their own accord — a call to us, or a WhatsApp message that is not about an absent
          date. Every query starts under Queries, and moves to Tickets once a ticket is raised from it. Click a row to
          read it.
        </p>
      </section>

      {/* The filters have a form of their own, empty here: their fields sit in the toolbar, inside the close form,
          and belong to this one through their `form` attribute - forms cannot nest. */}
      <form id="query-filters" method="get">
        {view === 'tickets' ? <input type="hidden" name="view" value="tickets" /> : null}
      </form>

      {view === 'queries' ? (
        <div className="card flush">
          {toolbar}
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Date &amp; time</th>
                  <th>Contact by</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? (
                  rows.map((row) => (
                    <RowLink key={row.id} href={`/queries/${row.id}`}>
                      <Employee row={row} />
                      <td className="nowrap">{formatTime(row.startedAt)}</td>
                      <td className="nowrap">{row.channel === 'voice' ? 'Call' : 'WhatsApp'}</td>
                      <Feedback row={row} />
                    </RowLink>
                  ))
                ) : (
                  <tr>
                    <td className="empty" colSpan={4}>
                      {filtered ? 'No queries match that filter.' : 'No queries yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <form action={closeTickets}>
          <input type="hidden" name="back" value={link('tickets')} />
          <SelectionProvider key={selectionKey} signature={selectionKey} rows={selectionRows}>
            <div className="card flush">
              {toolbar}
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>
                        <SelectAll />
                      </th>
                      <th>Employee</th>
                      <th>Date &amp; time</th>
                      <th>Contact by</th>
                      <th>Query type</th>
                      <th>Priority</th>
                      <th>Assigned to</th>
                      <th>Transferred to LT</th>
                      <th>Feedback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length ? (
                      rows.map((row) => {
                        const priority = row.priority ? PRIORITY[row.priority] : null;
                        return (
                          <RowLink key={row.id} href={`/queries/${row.id}`}>
                            <td className="row-control">{row.ticketStatus === 'open' ? <RowCheckbox value={row.id} /> : null}</td>
                            <Employee row={row} />
                            <td className="nowrap">{formatTime(row.startedAt)}</td>
                            <td className="nowrap">{row.channel === 'voice' ? 'Call' : 'WhatsApp'}</td>
                            <td>
                              {row.queryTypeName ?? <span className="sub">Unclassified</span>}
                              <div className="sub">
                                <span className="mono">{ticketLabel(row.ticketNo)}</span> ·{' '}
                                {row.ticketStatus === 'resolved' ? 'Resolved' : 'Open'}
                                {row.followsTicketNo ? (
                                  <>
                                    {' '}· follows <span className="mono">{ticketLabel(row.followsTicketNo)}</span>
                                  </>
                                ) : null}
                              </div>
                            </td>
                            <td className="nowrap">{priority ? <span className={`chip ${priority.tone}`}>{priority.label}</span> : '—'}</td>
                            <td>{row.assigneeName ?? <span className="sub">Not assigned</span>}</td>
                            <td className="nowrap">{row.ltTransferredAt ? 'Yes' : 'No'}</td>
                            <Feedback row={row} />
                          </RowLink>
                        );
                      })
                    ) : (
                      <tr>
                        <td className="empty" colSpan={9}>
                          {filtered ? 'No tickets match that filter.' : 'No tickets yet.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </SelectionProvider>
        </form>
      )}
    </>
  );
}
