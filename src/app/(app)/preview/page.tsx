import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { meaningLabel } from '@/lib/display';
import { previewCheck, runCheck } from '@/app/actions';

/**
 * Exactly who would be contacted over a range, with nothing sent. This is the
 * screen a customer signs off during onboarding, and the safe way to look
 * before a run.
 */
export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { from, to } = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const rangeFrom = from ?? today;
  const rangeTo = to ?? rangeFrom;

  const form = new FormData();
  form.set('from', rangeFrom);
  form.set('to', rangeTo);
  const result = await previewCheck(form);
  const rows = 'rows' in result ? result.rows : [];
  const fresh = rows.filter((row) => !row.alreadyOpen);

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">
          <Link href="/">← Dashboard</Link>
        </div>
        <h1>Preview</h1>
        <p>
          {rangeFrom === rangeTo ? rangeFrom : `${rangeFrom} to ${rangeTo}`} · {rows.length} gap
          {rows.length === 1 ? '' : 's'} found, {fresh.length} would be contacted. Nothing has been sent or called.
        </p>
      </section>

      <div className="card" style={{ marginTop: 18 }}>
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
            Preview
          </button>
        </form>
      </div>

      <div className="section-head" style={{ marginTop: 22 }}>
        <h2>Who would be contacted</h2>
        <span className="hint">Already-open dates are listed but never messaged again</span>
      </div>

      <div className="card table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Date</th>
              <th>Employee</th>
              <th>Attendance</th>
              <th>Number</th>
              <th>Contact by</th>
              <th>Would contact</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row) => (
                <tr key={`${row.date}-${row.code}`}>
                  <td className="nowrap">{row.date}</td>
                  <td>
                    <div className="employee">{row.name}</div>
                    <div className="sub">{row.code}</div>
                  </td>
                  <td>
                    <span className="pill idle">{row.raw ?? row.meaning}</span>
                    <div className="sub">{meaningLabel(row.meaning)}</div>
                  </td>
                  <td className="nowrap">{row.mobile ? `+${row.mobile}` : <span className="pill call">No number</span>}</td>
                  <td>
                    <span className="pill idle">{row.channel === 'voice' ? 'Call' : 'WhatsApp'}</span>
                  </td>
                  <td>
                    {row.alreadyOpen ? (
                      <span className="pill idle">Already open</span>
                    ) : row.mobile ? (
                      <span className="pill pending">Yes</span>
                    ) : (
                      <span className="pill call">Cannot</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="empty" colSpan={6}>
                  Nobody has an attendance gap in this range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {fresh.length ? (
        <form action={runCheck} style={{ marginTop: 18 }}>
          <input type="hidden" name="from" value={rangeFrom} />
          <input type="hidden" name="to" value={rangeTo} />
          <button className="btn primary" type="submit">
            Contact {fresh.length} {fresh.length === 1 ? 'person' : 'people'} now
          </button>
        </form>
      ) : null}
    </>
  );
}
