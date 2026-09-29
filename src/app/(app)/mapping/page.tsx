import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { mappingOverview } from '@/lib/queries';
import { meaningLabel, formatTime } from '@/lib/display';
import { analyseMappingFile, importAttendance, saveMapping, setCodeMeaning } from '@/app/actions';
import { MappingForm, type CodeRow, type MappingDraft } from './editor';
import { ALL_MEANINGS } from '@/lib/mapping/meanings';
import type { Analysis } from '@/lib/mapping/analyse';
import type { FieldMap } from '@/db/schema';

export default async function MappingPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; saved?: string; imported?: string; unresolved?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const [{ profile, draft, codes, unmapped, recentImports }, { problem, saved }] = await Promise.all([
    mappingOverview(tenantId),
    searchParams,
  ]);
  const { imported, unresolved } = await searchParams;
  const openUnmapped = unmapped.filter((u) => !u.resolvedAt);
  const analysis = (draft?.detected ?? null) as Analysis | null;
  const editing = toDraft(profile, codes, analysis);
  const suggestions = analysis?.columns.filter((c) => !c.looksLikeDay).map((c) => c.name) ?? [];

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
          Mapping saved and in use.{imported ? ` Imported ${imported}.` : ''}
          {unresolved ? ` ${unresolved} code${unresolved === '1' ? '' : 's'} still need a meaning — below.` : ''}
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

      <form action={saveMapping} style={{ marginTop: 16 }}>
        <MappingForm
          initial={editing}
          suggestions={suggestions}
          heading={profile ? 'The mapping for this customer' : 'Set up the mapping for this customer'}
          note={
            profile
              ? 'Change anything here and save. Nothing already imported is altered; the next import is read with the new rules.'
              : 'Fill this in from their column names and their list of codes. You can do it before they send a file — or upload one below and it will fill in what it can.'
          }
        />
      </form>

      <div className="layout">
        <div>

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
              {profile
                ? 'Read with the mapping below. Re-importing is safe: a corrected day overwrites the old one and can close an open case.'
                : 'This customer has no mapping yet, so the first file is read on screen and you say what its columns and codes mean.'}
            </p>
            <form action={profile ? importAttendance : analyseMappingFile}>
              <div className="field">
                <label htmlFor="file">Attendance file</label>
                <input className="input" type="file" id="file" name="file" accept=".xlsx,.xls,.csv" required />
              </div>
              <button className="btn primary" type="submit" style={{ marginTop: 10 }}>
                {profile ? 'Import' : 'Read it and show me'}
              </button>
            </form>
          </section>

          <section className="card pad">
            <div className="section-head">
              <h2>Fill the form from a file</h2>
            </div>
            <p className="hint" style={{ marginBottom: 12 }}>
              Optional. Upload one of their files and the form above is filled in with what it can work out — the
              column names it recognises and the codes it finds. Nothing is imported and nothing is saved until you
              press Save mapping.
            </p>
            <form action={analyseMappingFile}>
              <div className="field">
                <label htmlFor="mapFile">Their file</label>
                <input className="input" type="file" id="mapFile" name="file" accept=".xlsx,.xls,.csv" required />
              </div>
              <button className="btn" type="submit" style={{ marginTop: 10 }}>
                Fill in the form
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

/**
 * What the form opens with: the mapping in force, or the guesses from a file
 * somebody uploaded to save typing, or an empty form.
 */
function toDraft(
  profile: { name: string; hrmsHint: string | null; fieldMap: FieldMap } | null | undefined,
  codes: { code: string; meaning: string; chase: boolean | null }[],
  analysis: Analysis | null,
): MappingDraft {
  const thisYear = String(new Date().getFullYear());

  if (profile) {
    const dateLayout = profile.fieldMap.dateLayout;
    const statusLayout = profile.fieldMap.statusLayout;
    return {
      name: profile.name,
      hrmsHint: profile.hrmsHint ?? '',
      layout: dateLayout.kind,
      dateColumn: dateLayout.kind === 'row_per_day' ? dateLayout.column : '',
      headerPattern: dateLayout.kind === 'column_per_day' ? dateLayout.headerPattern : '',
      year: dateLayout.kind === 'column_per_day' ? String(dateLayout.year ?? '') : '',
      separator: statusLayout.kind === 'two_session' ? statusLayout.separator : '',
      fields: Object.fromEntries(
        Object.entries(profile.fieldMap.fields).map(([field, spec]) => [field, spec.columns.join(', ')]),
      ),
      codes: codes.map((c) => ({ code: c.code, meaning: c.meaning as CodeRow['meaning'], chase: c.chase === true })),
    };
  }

  if (analysis) {
    return {
      name: `${analysis.sheetName} export`,
      hrmsHint: '',
      layout: analysis.layout,
      dateColumn: analysis.columns.find((c) => /date|day/i.test(c.name))?.name ?? '',
      headerPattern: '',
      year: String(analysis.year ?? new Date().getFullYear()),
      separator: analysis.separator ?? '',
      fields: Object.fromEntries(
        Object.entries(analysis.fields).map(([field, columns]) => [field, (columns ?? []).join(', ')]),
      ),
      codes: analysis.codes.map((c) => ({ code: c.code, meaning: c.guess, chase: false })),
    };
  }

  return {
    name: '',
    hrmsHint: '',
    layout: 'row_per_day',
    dateColumn: '',
    headerPattern: '',
    year: thisYear,
    separator: '',
    fields: {},
    codes: [],
  };
}
