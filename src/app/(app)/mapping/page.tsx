import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { mappingOverview } from '@/lib/queries';
import { meaningLabel, formatTime } from '@/lib/display';
import { analyseMappingFile, importAttendance, saveMapping, setCodeMeaning } from '@/app/actions';
import { MappingEditor } from './editor';
import { ALL_MEANINGS } from '@/lib/mapping/meanings';
import type { Analysis } from '@/lib/mapping/analyse';

export default async function MappingPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; saved?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const [{ profile, draft, codes, unmapped, recentImports }, { problem, saved }] = await Promise.all([
    mappingOverview(tenantId),
    searchParams,
  ]);
  const openUnmapped = unmapped.filter((u) => !u.resolvedAt);
  const analysis = (draft?.detected ?? null) as Analysis | null;

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

      {problem ? (
        <div className="notice err" style={{ margin: '16px 0 0' }}>
          {problem}
        </div>
      ) : null}
      {saved ? (
        <div className="notice ok" style={{ margin: '16px 0 0' }}>
          Mapping saved and in use. Import the file to read it with these rules.
        </div>
      ) : null}

      {openUnmapped.length ? (
        <section className="card pad" style={{ marginTop: 16, borderColor: 'var(--danger-text)' }}>
          <div className="section-head">
            <h2>Codes nobody has explained</h2>
            <span className="hint">never messaged about until they have a meaning</span>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Code</th>
                  <th style={{ width: 90 }}>Seen</th>
                  <th>Means</th>
                </tr>
              </thead>
              <tbody>
                {openUnmapped.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.code}</code>
                    </td>
                    <td className="nowrap">{row.occurrences}</td>
                    <td>
                      <form action={setCodeMeaning} className="row" style={{ padding: 0, gap: 8 }}>
                        <input type="hidden" name="code" value={row.code} />
                        <select className="input" name="meaning" defaultValue="unknown" style={{ maxWidth: 280 }}>
                          {ALL_MEANINGS.map((meaning) => (
                            <option key={meaning} value={meaning}>
                              {meaning === 'unknown' ? 'Not recognised — never chase' : meaningLabel(meaning)}
                            </option>
                          ))}
                        </select>
                        <button className="btn small" type="submit">
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {analysis && draft ? (
        <form action={saveMapping} style={{ marginTop: 16 }}>
          <MappingEditor analysis={analysis} profileId={draft.id} />
        </form>
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
              <button className="btn primary" type="submit" style={{ marginTop: 10 }} disabled={!profile}>
                Import
              </button>
              {!profile ? (
                <p className="hint" style={{ marginTop: 8 }}>
                  Nothing can be imported until this customer has a mapping. Start below.
                </p>
              ) : null}
            </form>
          </section>

          <section className="card pad">
            <div className="section-head">
              <h2>Set up a new mapping</h2>
            </div>
            <p className="hint" style={{ marginBottom: 12 }}>
              Upload one month exactly as their HRMS exports it. Nothing is imported — the file is read to work out
              which column is which and what their codes mean, and you correct the guesses.
            </p>
            <form action={analyseMappingFile}>
              <div className="field">
                <label htmlFor="mapFile">Their file</label>
                <input className="input" type="file" id="mapFile" name="file" accept=".xlsx,.xls,.csv" required />
              </div>
              <button className="btn" type="submit" style={{ marginTop: 10 }}>
                Read it and show me
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
