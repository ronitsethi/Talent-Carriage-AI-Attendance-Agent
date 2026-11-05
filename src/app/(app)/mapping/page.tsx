import { redirect } from 'next/navigation';
import { canManageSettings, getActiveTenantId, getSession } from '@/lib/auth';
import { mappingOverview } from '@/lib/queries';
import { meaningLabel, formatTime } from '@/lib/display';
import {
  analyseMappingFile,
  importAttendance,
  lockAttendance,
  saveMapping,
  sendAfterUnlock,
  sendAfterUpload,
  setCodeMeaning,
  unlockAttendance,
} from '@/app/actions';
import { ConfirmSubmit } from '@/components/confirm';
import { UnlockChoice, UnlockMonths } from '@/components/attendance-lock';
import { attendanceLockOverview } from '@/lib/queries';
import { monthLabel } from '@/lib/locks';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import { Toast } from '@/components/toast';
import { UploadChoice } from '@/components/upload-choice';
import { previewUnlockSend, previewUploadSend } from '@/lib/upload-send';
import { MappingForm, type CodeRow, type MappingDraft } from './editor';
import { ALL_MEANINGS } from '@/lib/mapping/meanings';
import type { Analysis } from '@/lib/mapping/analyse';
import type { FieldMap } from '@/db/schema';
import type { ImportReport } from '@/db/schema';

/** What an upload settled by itself, in a sentence. Empty when it settled nothing. */
function settledByUpload(resolved: number, removed: number): string {
  const parts = [];
  if (resolved) parts.push(`${resolved} ${resolved === 1 ? 'case' : 'cases'} resolved`);
  if (removed) parts.push(`${removed} unopened ${removed === 1 ? 'case' : 'cases'} removed`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

const startsIn = (minutes: number) => (minutes ? `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'now');

export default async function MappingPage({
  searchParams,
}: {
  searchParams: Promise<{
    problem?: string;
    saved?: string;
    uploaded?: string;
    resolved?: string;
    removed?: string;
    scheduled?: string;
    after?: string;
    locked?: string;
    moved?: string;
    unlocked?: string;
    restored?: string;
  }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const [
    { profile, draft, codes, unmapped, recentImports },
    { problem, saved, uploaded, resolved, removed, scheduled, after, locked, moved, unlocked, restored },
    locks,
  ] = await Promise.all([mappingOverview(tenantId), searchParams, attendanceLockOverview(tenantId)]);
  const choice = uploaded ? await previewUploadSend(tenantId, uploaded) : null;
  const unlockedMonths = (unlocked ?? '').split(',').filter(Boolean);
  const unlockChoice = unlockedMonths.length ? await previewUnlockSend(tenantId, unlockedMonths) : null;
  const unlockedNames = unlockedMonths.map((month) => monthLabel(month)).join(', ');
  const admin = canManageSettings(session);
  const settled = settledByUpload(Number(resolved ?? 0), Number(removed ?? 0));
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
      {saved ? <Toast clear={['saved']}>Mapping saved and in use.</Toast> : null}
      {scheduled ? (
        <Toast clear={['scheduled', 'after']}>
          {Number(scheduled)
            ? `${scheduled} ${Number(scheduled) === 1 ? 'person' : 'people'} will be contacted, starting ${startsIn(Number(after))}.`
            : 'Nobody is due a call or message.'}
        </Toast>
      ) : null}
      {uploaded && !choice?.people ? (
        <Toast clear={['uploaded', 'resolved', 'removed']}>Attendance updated. {settled}</Toast>
      ) : null}
      {uploaded && choice?.people ? (
        <UploadChoice importId={uploaded} action={sendAfterUpload}>
          {settled ? <p>{settled}</p> : null}
          <p>
            Do you want to send today&apos;s calls/messages, or just update the attendance data?{' '}
            <strong>
              {choice.firstContact} to ask about an absence, {choice.followUps} due a follow-up
            </strong>
            , starting {startsIn(choice.delayMinutes)}.
          </p>
          {choice.sendingEnabled ? null : (
            <p>
              <strong>Sending is switched off in Settings, so nothing would reach anyone.</strong>
            </p>
          )}
        </UploadChoice>
      ) : null}

      {locked ? (
        <Toast clear={['locked', 'moved']}>
          {monthLabel(locked)}&apos;s attendance is locked.{' '}
          {Number(moved) ? `${moved} open ${Number(moved) === 1 ? 'case' : 'cases'} moved to Unresolved.` : 'No case was open.'}
        </Toast>
      ) : null}
      {unlockedMonths.length && !unlockChoice?.people ? (
        <Toast clear={['unlocked', 'restored']}>
          Attendance unlocked for {unlockedNames}. {Number(restored) ? `${restored} ${Number(restored) === 1 ? 'case is' : 'cases are'} back where they were.` : ''}
        </Toast>
      ) : null}
      {unlockedMonths.length && unlockChoice?.people ? (
        <UnlockChoice months={unlockedMonths.join(',')} action={sendAfterUnlock}>
          <p>
            Attendance unlocked for {unlockedNames}. Do you want to send the{' '}
            <strong>
              {unlockChoice.firstContact} unopened absence calls/messages and {unlockChoice.followUps}{' '}
              {unlockChoice.followUps === 1 ? 'follow-up' : 'follow-ups'}
            </strong>
            ? They start {startsIn(unlockChoice.delayMinutes)}.
          </p>
          {unlockChoice.sendingEnabled ? null : (
            <p>
              <strong>Sending is switched off in Settings, so nothing would reach anyone.</strong>
            </p>
          )}
        </UnlockChoice>
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

      <section className="card pad gap-below">
        <div className="section-head">
          <h2>Lock attendance</h2>
        </div>
        <p className="card-desc">
          A locked month is final: uploads skip its days, nobody is contacted about it, and its open cases move to
          Unresolved. Unlocking puts every case back where it was.{admin ? '' : ' Only an admin can lock or unlock.'}
        </p>
        {admin ? (
          <div className="lock-row">
            <form action={lockAttendance} className="lock-form">
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="lock-month">Month</label>
                <select className="input" id="lock-month" name="month" defaultValue={locks.lockable[0] ?? ''} disabled={!locks.lockable.length}>
                  {locks.lockable.map((month) => (
                    <option key={month} value={month}>
                      {monthLabel(month)}
                    </option>
                  ))}
                </select>
              </div>
              <ConfirmSubmit
                label="Lock attendance"
                className="btn primary"
                disabled={!locks.lockable.length}
                title="Lock this month's attendance?"
                message={
                  <>
                    <p>
                      The month becomes final. Uploads skip its days, nobody is contacted about it, and every case of it
                      still open moves to Unresolved, including follow-ups and requests waiting on a manager.
                    </p>
                    <p>Anyone who replies about it is told once that it is locked and to speak to their manager.</p>
                  </>
                }
                confirmLabel="Lock it"
              />
            </form>
            <UnlockMonths months={locks.locks.map((lock) => ({ value: lock.month, label: monthLabel(lock.month) }))} action={unlockAttendance} />
          </div>
        ) : null}
        {locks.locks.length ? (
          <ul className="lock-list">
            {locks.locks.map((lock) => (
              <li key={lock.month}>
                <strong>{monthLabel(lock.month)}</strong>
                <span className="sub">
                  {' '}
                  · locked {formatTime(lock.lockedAt)}
                  {lock.lockedByName ? ` by ${lock.lockedByName}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No month is locked.</p>
        )}
      </section>

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
/** Within this of finishing, an import is what somebody just did rather than history. */
const JUST_NOW_MS = 2 * 60_000;

function ImportOutcome({
  row,
}: {
  row: {
    filename: string | null;
    status: string;
    error: string | null;
    report: ImportReport | null;
    startedAt: Date;
    finishedAt: Date | null;
  };
}) {
  if (row.status === 'failed') {
    return (
      <Notice tone="err">
        <strong>{row.filename} could not be read.</strong> {row.error}
      </Notice>
    );
  }

  const report = row.report;
  if (!report) return null;

  // A file of nothing but locked months: read fine, but that attendance is final.
  if (report.employeesSeen && !report.daysImported && report.daysLocked && !report.daysHeldBack) {
    return (
      <Notice tone="info">
        <strong>Nothing was imported from {row.filename}.</strong> All of its days are in{' '}
        {(report.lockedMonths ?? []).map((month) => monthLabel(month)).join(', ')}, whose attendance is locked.
      </Notice>
    );
  }

  // A file of nothing but today: read fine, but today is not over, so nothing went in.
  if (report.employeesSeen && !report.daysImported && report.daysHeldBack) {
    return (
      <Notice tone="info">
        <strong>Nothing was imported from {row.filename}.</strong> It only has today&rsquo;s attendance, which is left out
        until the day is over. Upload it again tomorrow.
      </Notice>
    );
  }

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
  const said = (
    <>
      Imported {report.daysImported} days for {report.employeesSeen}{' '}
      {report.employeesSeen === 1 ? 'employee' : 'employees'} from {row.filename}.
      {report.rejected.length ? ` ${report.rejected.length} rows skipped.` : ''}
      {report.daysHeldBack ? ` Today’s attendance was left out (${report.daysHeldBack} days), as the day is not over yet.` : ''}
      {report.daysLocked
        ? ` ${report.daysLocked} days in ${(report.lockedMonths ?? []).map((month) => monthLabel(month)).join(', ') || 'a locked month'} were skipped: that attendance is locked.`
        : ''}
      {report.employeesRestored
        ? ` ${report.employeesRestored} deleted ${report.employeesRestored === 1 ? 'employee is' : 'employees are'} back, with any cases that were kept when they were deleted.`
        : ''}
    </>
  );

  // Codes with no meaning are work left to do on this page, so they stay put
  // until somebody deals with them.
  if (unresolved.length) {
    return (
      <Notice tone="err">
        {said} {unresolved.join(', ')} {unresolved.length === 1 ? 'has' : 'have'} no meaning yet — nobody is messaged
        about {unresolved.length === 1 ? 'it' : 'them'} until you add {unresolved.length === 1 ? 'it' : 'them'} below.
      </Notice>
    );
  }

  // An import that went through needs no acknowledging: it is said once, in the
  // corner, and Recent imports below keeps the record.
  const finished = row.finishedAt ?? row.startedAt;
  if (Date.now() - finished.getTime() > JUST_NOW_MS) return null;
  return <Toast>{said}</Toast>;
}
