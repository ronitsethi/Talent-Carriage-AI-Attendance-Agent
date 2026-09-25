import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { mappingOverview } from '@/lib/queries';
import { meaningLabel, formatTime } from '@/lib/display';
import { importAttendance } from '@/app/actions';

export default async function MappingPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { profile, codes, unmapped, recentImports } = await mappingOverview(tenantId);
  const openUnmapped = unmapped.filter((u) => !u.resolvedAt);

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">⇄ Mapping &amp; import</div>
        <h1>How this customer&apos;s data is read</h1>
        <p>
          Their columns and codes are translated into the platform&apos;s own vocabulary once. Everything after that —
          detection, messaging, actions and reporting — is identical for every customer.
        </p>
      </section>

      {openUnmapped.length ? (
        <div className="notice err" style={{ margin: '16px 0 0' }}>
          {openUnmapped.length} code{openUnmapped.length === 1 ? '' : 's'} in the last import have no mapping:{' '}
          {openUnmapped.map((u) => u.code).join(', ')}. They are never messaged about until someone says what they mean.
        </div>
      ) : null}

      <div className="layout">
        <div>
          <section className="section">
            <div className="section-head">
              <h2>Attendance codes</h2>
              <span className="hint">{profile ? `${profile.name} · version ${profile.version}` : 'No active profile'}</span>
            </div>
            <div className="card table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Their code</th>
                    <th>Means</th>
                    <th>Chased</th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map((code) => (
                    <tr key={code.id}>
                      <td>
                        <code>{code.code}</code>
                      </td>
                      <td>{meaningLabel(code.meaning)}</td>
                      <td>
                        {code.chase === null ? (
                          <span className="sub">default</span>
                        ) : code.chase ? (
                          <span className="pill pending">Yes</span>
                        ) : (
                          <span className="pill idle">No</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!codes.length ? (
                    <tr>
                      <td className="empty" colSpan={3}>
                        No code mappings yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Recent imports</h2>
            </div>
            <div className="card table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Source</th>
                    <th>Covering</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {recentImports.map((row) => (
                    <tr key={row.id}>
                      <td className="nowrap">{formatTime(row.startedAt)}</td>
                      <td>
                        {row.source}
                        <div className="sub">{row.filename ?? '—'}</div>
                      </td>
                      <td className="nowrap">
                        {row.dateFrom} → {row.dateTo}
                      </td>
                      <td>
                        {row.report ? (
                          <>
                            {row.report.daysImported} days · {row.report.employeesCreated} new employees
                            {row.report.rejected.length ? (
                              <div className="sub">{row.report.rejected.length} rows rejected</div>
                            ) : null}
                          </>
                        ) : (
                          row.status
                        )}
                      </td>
                    </tr>
                  ))}
                  {!recentImports.length ? (
                    <tr>
                      <td className="empty" colSpan={4}>
                        Nothing imported yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside>
          <section className="card pad">
            <div className="section-head">
              <h2>Import attendance</h2>
            </div>
            <p className="hint" style={{ marginBottom: 12 }}>
              The same file the HRMS exports. Re-importing is safe: a corrected day overwrites the old one and can close
              an open case.
            </p>
            <form action={importAttendance}>
              <div className="field">
                <label htmlFor="file">Attendance file</label>
                <input className="input" type="file" id="file" name="file" accept=".xlsx,.xls,.csv" required />
              </div>
              <button className="btn primary" type="submit" style={{ marginTop: 10 }}>
                Import
              </button>
            </form>
          </section>

          {profile ? (
            <section className="card pad">
              <div className="section-head">
                <h2>Layout</h2>
              </div>
              <dl className="kv">
                <dt>HRMS</dt>
                <dd>{profile.hrmsHint ?? '—'}</dd>
                <dt>Dates</dt>
                <dd>{profile.fieldMap.dateLayout.kind.replace(/_/g, ' ')}</dd>
                <dt>Status</dt>
                <dd>{profile.fieldMap.statusLayout.kind.replace(/_/g, ' ')}</dd>
                <dt>Fields mapped</dt>
                <dd>{Object.keys(profile.fieldMap.fields).length}</dd>
              </dl>
              <p className="hint" style={{ marginTop: 10 }}>{profile.notes}</p>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
