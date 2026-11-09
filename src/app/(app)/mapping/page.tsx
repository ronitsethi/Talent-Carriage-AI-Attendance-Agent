import Link from 'next/link';
import { redirect } from 'next/navigation';
import { canManageSettings, getActiveTenantId, getSession } from '@/lib/auth';
import { LeaveBalanceMapping } from '@/components/leave-balance-mapping';
import { PayrollMapping } from '@/components/payroll-mapping';
import { mappingOverview } from '@/lib/queries';
import { meaningLabel } from '@/lib/display';
import { analyseMappingFile, saveMapping, setCodeMeaning } from '@/app/actions';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import { Toast } from '@/components/toast';
import { MappingForm, type CodeRow, type MappingDraft } from './editor';
import { ALL_MEANINGS } from '@/lib/mapping/meanings';
import type { Analysis } from '@/lib/mapping/analyse';
import type { FieldMap } from '@/db/schema';

/**
 * Mapping: how each of this customer's files is read, set up once. Attendance
 * (columns, layout and codes), leave balances and payroll each have a tab. The
 * files themselves are uploaded on Uploads, and payroll on Month end.
 */

const TABS = [
  { key: 'attendance', label: 'Attendance' },
  { key: 'leave', label: 'Leave balance' },
  { key: 'payroll', label: 'Payroll' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export default async function MappingPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    problem?: string;
    saved?: string;
    payrollFilled?: string;
    payrollSaved?: string;
    leaveFilled?: string;
    leaveSaved?: string;
  }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const params = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === params.tab) ? (params.tab as Tab) : 'attendance';

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Mapping</div>
        <h1>How this customer&apos;s files are read</h1>
        <p>
          Their columns and codes are translated into the platform&apos;s own vocabulary once, for each kind of file.
          Attendance and leave balances are then uploaded on <Link href="/uploads">Uploads</Link>, and payroll on{' '}
          <Link href="/month-end">Month end</Link>.
        </p>
      </section>

      <nav className="switch-group gap-below" aria-label="Which file">
        {TABS.map(({ key, label }) => (
          <Link
            key={key}
            href={key === 'attendance' ? '/mapping' : `/mapping?tab=${key}`}
            className={`switch-option ${tab === key ? 'on' : ''}`}
            aria-current={tab === key ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>

      {params.problem ? (
        <Notice tone="err" clear={['problem']}>
          {params.problem}
        </Notice>
      ) : null}

      {tab === 'attendance' ? <AttendanceMapping tenantId={tenantId} saved={params.saved} /> : null}
      {tab === 'leave' ? <LeaveBalanceMapping tenantId={tenantId} filled={params.leaveFilled} saved={params.leaveSaved} /> : null}
      {tab === 'payroll' ? (
        <PayrollMapping tenantId={tenantId} admin={canManageSettings(session)} filled={params.payrollFilled} saved={params.payrollSaved} />
      ) : null}
    </>
  );
}

/** The attendance mapping: fill it from a file, explain new codes, and the form itself. */
async function AttendanceMapping({ tenantId, saved }: { tenantId: string; saved?: string }) {
  const { profile, draft, codes, unmapped, recentImports } = await mappingOverview(tenantId);
  const latest = recentImports[0];
  const openUnmapped = unmapped.filter((u) => !u.resolvedAt);
  const analysis = (draft?.detected ?? null) as Analysis | null;
  const editing = toDraft(profile, codes, analysis);
  const suggestions = analysis?.columns.filter((c) => !c.looksLikeDay).map((c) => c.name) ?? [];

  return (
    <>
      {saved ? <Toast clear={['saved']}>Mapping saved and in use.</Toast> : null}

      <section className="card pad gap-below">
        <div className="section-head">
          <h2>Fill the form from a file</h2>
        </div>
        <p className="card-desc">
          {profile
            ? 'Optional. Upload one of their files and the form below is filled in with what it can work out — the column names it recognises and the codes it finds.'
            : 'This customer has no attendance mapping yet. Upload one of their files and the form below is filled in with what it can work out, or fill it in by hand.'}{' '}
          Nothing is imported and nothing is saved until you press Save mapping. Attendance is imported on{' '}
          <Link href="/uploads">Uploads</Link>.
        </p>
        <form action={analyseMappingFile} className="upload-row">
          <FileDrop id="mapFile" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Their file" required />
          <button className="btn lg" type="submit">
            Fill in the form
          </button>
        </form>
      </section>

      {openUnmapped.length ? (
        <section className="card flush danger gap-below" id="codes">
          <div className="card-head danger">
            <h2>Codes nobody has explained</h2>
            <span className="hint" style={{ color: 'inherit' }}>
              from attendance or leave balance files · never messaged about, and no leave type, until they have a meaning
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
          heading={profile ? 'The attendance mapping for this customer' : 'Set up the attendance mapping for this customer'}
          note={
            profile
              ? 'Change anything here and save. Nothing already imported is altered; the next import is read with the new rules.'
              : 'Fill this in from their column names and their list of codes. You can do it before they send a file — or upload one above and it will fill in what it can.'
          }
        />
      </form>

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
          {profile.notes ? (
            <p className="hint" style={{ marginTop: 12 }}>
              {profile.notes}
            </p>
          ) : null}
        </section>
      ) : null}
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
