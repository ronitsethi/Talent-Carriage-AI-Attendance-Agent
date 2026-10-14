import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { mappingOverview } from '@/lib/queries';
import { meaningLabel, formatTime } from '@/lib/display';
import { analyseMappingFile, importAttendance, saveMapping, setCodeMeaning } from '@/app/actions';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import { MappingForm, type CodeRow, type MappingDraft } from './editor';
import { ALL_MEANINGS } from '@/lib/mapping/meanings';
import type { Analysis } from '@/lib/mapping/analyse';
import type { FieldMap } from '@/db/schema';
import type { ImportReport } from '@/db/schema';

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
  const latest = recentImports[0];
  const openUnmapped = unmapped.filter((u) => !u.resolvedAt);
  const analysis = (draft?.detected ?? null) as Analysis | null;
  const editing = toDraft(profile, codes, analysis);
  const suggestions = analysis?.columns.filter((c) => !c.looksLikeDay).map((c) => c.name) ?? [];

  const imports = (
    <section className="card flush">
      <div className="card-head">
        <h2>Recent imports</h2>
      </div>
      <div className="table-scroll">
        <table className="data small">
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
                  <div className="sub mono">{row.filename ?? '—'}</div>
                </td>
                <td className="nowrap mono" style={{ fontSize: 'var(--fs-meta)' }}>
                  {row.dateFrom} → {row.dateTo}
                </td>
                <td>
                  {row.report ? (
                    <>
                      {row.report.daysImported} days · {row.report.employeesCreated} new employees
                      {row.report.rejected.length ? <div className="sub">{row.report.rejected.length} rows rejected</div> : null}
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
  );

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Mapping &amp; import</div>
        <h1>How this customer&apos;s data is read</h1>
        <p>
          Their columns and codes are translated into the platform&apos;s own vocabulary once. Everything after that —
          detection, messaging, actions and reporting — is identical for every customer.
        </p>
      </section>

      {problem ? (
        <Notice tone="err" clear={['problem']}>
          {problem}
        </Notice>
      ) : null}
      {saved ? (
        <Notice tone="ok" clear={['saved']}>
          Mapping saved and in use.
        </Notice>
      ) : null}

      {latest ? <ImportOutcome row={latest} /> : null}

      <div className="tiles narrow gap-below">
        <section className="card pad">
          <div className="section-head">
            <h2>Import attendance</h2>
          </div>
          <p className="card-desc">
            {profile
              ? 'Read with the mapping below. Re-importing is safe: a corrected day overwrites the old one and can close an open case.'
              : 'This customer has no mapping yet, so the first file is read on screen and you say what its columns and codes mean.'}
          </p>
          <form action={profile ? importAttendance : analyseMappingFile} className="upload-row">
            <FileDrop id="file" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Choose attendance file" required />
            <button className="btn primary lg" type="submit">
              {profile ? 'Import' : 'Read it and show me'}
            </button>
          </form>
        </section>

        <section className="card pad">
          <div className="section-head">
            <h2>Fill the form from a file</h2>
          </div>
          <p className="card-desc">
            Optional. Upload one of their files and the form below is filled in with what it can work out — the column
            names it recognises and the codes it finds. Nothing is imported and nothing is saved until you press Save
            mapping.
          </p>
          <form action={analyseMappingFile} className="upload-row">
            <FileDrop id="mapFile" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Their file" required />
            <button className="btn lg" type="submit">
              Fill in the form
            </button>
          </form>
        </section>
      </div>

      {openUnmapped.length ? (
        <section className="card flush danger gap-below">
          <div className="card-head danger">
            <h2>Codes nobody has explained</h2>
            <span className="hint" style={{ color: 'inherit' }}>
              never messaged about until they have a meaning
            </span>
          </div>
          {openUnmapped.map((row) => (
            <form key={row.id} action={setCodeMeaning} className="unmapped-row">
              <input type="hidden" name="code" value={row.code} />
              <span className="code-chip">{row.code}</span>
              <span className="hint" style={{ width: 70 }}>
                seen {row.occurrences}×
              </span>
              <select className="input sm" name="meaning" defaultValue="unknown" aria-label={`What ${row.code} means`}>
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
          ))}
        </section>
      ) : null}

      <form action={saveMapping} className="gap-below">
        <MappingForm
          initial={editing}
          suggestions={suggestions}
          resolvedYear={latest?.dateFrom ? Number(latest.dateFrom.slice(0, 4)) : null}
          heading={profile ? 'The mapping for this customer' : 'Set up the mapping for this customer'}
          note={
            profile
              ? 'Change anything here and save. Nothing already imported is altered; the next import is read with the new rules.'
              : 'Fill this in from their column names and their list of codes. You can do it before they send a file — or upload one above and it will fill in what it can.'
          }
        />
      </form>

      {profile ? (
        <div className="layout">
          {imports}
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
            {profile.notes ? (
              <p className="hint" style={{ marginTop: 12 }}>
                {profile.notes}
              </p>
            ) : null}
          </section>
        </div>
      ) : (
        imports
      )}
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

/**
 * What the last import did, taken from the import itself rather than carried in
 * the URL - a long message in a redirect is how this page started returning
 * headers too big for the browser to accept.
 */
function ImportOutcome({ row }: { row: { filename: string | null; status: string; error: string | null; report: ImportReport | null } }) {
  if (row.status === 'failed') {
    return (
      <Notice tone="err">
        <strong>{row.filename} could not be read.</strong> {row.error}
      </Notice>
    );
  }

  const report = row.report;
  if (!report) return null;

  // Nothing read is never a success: it means the mapping does not fit the file.
  if (!report.employeesSeen || !report.daysImported) {
    return (
      <Notice tone="err">
        <strong>Nothing was read from {row.filename}.</strong> The mapping below does not match it — check the column
        names and the date layout against the file.
        {report.rejected.length ? ` Every row was skipped: ${report.rejected[0]!.reason}.` : ''}
      </Notice>
    );
  }

  const unresolved = Object.keys(report.unmappedCodes ?? {});
  return (
    <Notice tone={unresolved.length ? 'err' : 'ok'}>
      Imported {report.daysImported} days for {report.employeesSeen}{' '}
      {report.employeesSeen === 1 ? 'employee' : 'employees'} from {row.filename}.
      {report.rejected.length ? ` ${report.rejected.length} rows skipped.` : ''}
      {unresolved.length
        ? ` ${unresolved.join(', ')} ${unresolved.length === 1 ? 'has' : 'have'} no meaning yet — nobody is messaged about ${unresolved.length === 1 ? 'it' : 'them'} until you add ${unresolved.length === 1 ? 'it' : 'them'} below.`
        : ''}
    </Notice>
  );
}
