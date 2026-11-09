import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { uploadsOverview } from '@/lib/queries';
import { formatTime } from '@/lib/display';
import { importAttendance, sendAfterUpload, uploadLeaveBalances } from '@/app/actions';
import { monthLabel } from '@/lib/locks';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import { Toast } from '@/components/toast';
import { UploadChoice } from '@/components/upload-choice';
import { previewUploadSend } from '@/lib/upload-send';
import type { ImportReport, LeaveReport } from '@/db/schema';

/**
 * Uploads: the files a customer sends most often, attendance and leave
 * balances. Each is read with its mapping, set up once on Mapping. Payroll is
 * on Month end, as it waits for the month's attendance to be locked.
 */

/** What an upload settled by itself, in a sentence. Empty when it settled nothing. */
function settledByUpload(resolved: number, removed: number): string {
  const parts = [];
  if (resolved) parts.push(`${resolved} ${resolved === 1 ? 'case' : 'cases'} resolved`);
  if (removed) parts.push(`${removed} unopened ${removed === 1 ? 'case' : 'cases'} removed`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

const startsIn = (minutes: number) => (minutes ? `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'now');

export default async function UploadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    uploaded?: string;
    resolved?: string;
    removed?: string;
    scheduled?: string;
    after?: string;
    leave?: string;
    leaveProblem?: string;
  }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const [overview, params] = await Promise.all([uploadsOverview(tenantId), searchParams]);
  const { attendanceMapped, unmapped, recentImports, leaveMapped, leaveUploads, peopleWithBalances } = overview;
  const { uploaded, resolved, removed, scheduled, after } = params;
  const choice = uploaded ? await previewUploadSend(tenantId, uploaded) : null;
  const settled = settledByUpload(Number(resolved ?? 0), Number(removed ?? 0));
  const latest = recentImports[0];
  const leaveDone = params.leave ? leaveUploads.find((u) => u.id === params.leave) ?? null : null;

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Uploads</div>
        <h1>Uploads</h1>
        <p>
          Attendance and leave balances, as often as they come. Each file is read with its mapping on{' '}
          <Link href="/mapping">Mapping</Link>. Payroll is uploaded on <Link href="/month-end">Month end</Link>, once the
          month&apos;s attendance is locked.
        </p>
      </section>

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

      {/* ---------------- Attendance ---------------- */}
      <section className="card pad gap-below" id="attendance">
        <div className="section-head">
          <h2>Attendance</h2>
        </div>
        {latest ? <ImportOutcome row={latest} /> : null}
        {unmapped.length ? (
          <Notice tone="err">
            {unmapped.join(', ')} {unmapped.length === 1 ? 'has' : 'have'} no meaning yet: nobody is messaged about{' '}
            {unmapped.length === 1 ? 'it' : 'them'}, and as a leave type which leave {unmapped.length === 1 ? 'it is' : 'they are'} is not
            known. Say what {unmapped.length === 1 ? 'it means' : 'they mean'} on <Link href="/mapping#codes">Mapping</Link>.
          </Notice>
        ) : null}
        {attendanceMapped ? (
          <>
            <p className="card-desc">
              Read with the attendance mapping. Re-importing is safe: a corrected day overwrites the old one and can close an
              open case. Today&apos;s attendance and locked months are left out.
            </p>
            <form action={importAttendance} className="upload-row">
              <FileDrop id="file" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Choose attendance file" required />
              <button className="btn primary lg" type="submit">
                Import attendance
              </button>
            </form>
          </>
        ) : (
          <p className="hint">
            Set up the attendance mapping on <Link href="/mapping">Mapping</Link> first: which column of the file is which and
            what each code means. Attendance can be imported here once it is saved.
          </p>
        )}
      </section>

      <section className="card flush gap-below">
        <div className="card-head">
          <h2>Recent attendance imports</h2>
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

      {/* ---------------- Leave balances ---------------- */}
      <section className="card pad gap-below" id="leave-balance">
        <div className="section-head">
          <h2>Leave balances</h2>
        </div>
        {params.leaveProblem ? (
          <Notice tone="err" clear={['leaveProblem']}>
            {params.leaveProblem}
          </Notice>
        ) : null}
        {leaveDone?.report ? <LeaveOutcome filename={leaveDone.filename} report={leaveDone.report} /> : null}
        {leaveMapped ? (
          <>
            <p className="card-desc">
              How much leave each employee has left, by leave type. Each upload replaces the balances of everyone in the file;
              nobody else&apos;s change. The agent answers leave balance questions from the latest one, together with the
              attendance.{peopleWithBalances ? ` ${peopleWithBalances} ${peopleWithBalances === 1 ? 'employee has' : 'employees have'} a balance now.` : ''}
            </p>
            <form action={uploadLeaveBalances} className="upload-row">
              <FileDrop id="leave-file" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Choose leave balance file" required />
              <button className="btn primary lg" type="submit">
                Upload leave balances
              </button>
            </form>
          </>
        ) : (
          <p className="hint">
            Set up the leave balance mapping on <Link href="/mapping?tab=leave">Mapping</Link> first: which column of the file
            is the employee code, the leave type and the balance. Leave balances can be uploaded here once it is saved.
          </p>
        )}
      </section>

      <section className="card flush">
        <div className="card-head">
          <h2>Recent leave balance uploads</h2>
        </div>
        <div className="table-scroll">
          <table className="data small">
            <thead>
              <tr>
                <th>When</th>
                <th>File</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {leaveUploads.map((row) => (
                <tr key={row.id}>
                  <td className="nowrap">{formatTime(row.uploadedAt)}</td>
                  <td className="mono">{row.filename ?? '—'}</td>
                  <td>
                    {row.report ? (
                      <>
                        {row.report.employees} employees · {row.report.balances} balances
                        {row.report.unmatched.length ? <div className="sub">{row.report.unmatched.length} {row.report.unmatched.length === 1 ? 'code' : 'codes'} not found</div> : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              {!leaveUploads.length ? (
                <tr>
                  <td className="empty" colSpan={3}>
                    No leave balances uploaded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** What a leave balance upload did. */
function LeaveOutcome({ filename, report }: { filename: string | null; report: LeaveReport }) {
  if (!report.employees) {
    return (
      <Notice tone="err" clear={['leave']}>
        <strong>No balances were read from {filename}.</strong>{' '}
        {report.unmatched.length
          ? `None of its ${report.unmatched.length} employee codes are employees here.`
          : 'Check the leave balance mapping against the file.'}
      </Notice>
    );
  }
  return (
    <Notice tone={report.unmatched.length || report.skipped || report.unexplained?.length || report.untyped?.length ? 'info' : 'ok'} clear={['leave']}>
      <strong>
        Leave balances updated for {report.employees} {report.employees === 1 ? 'employee' : 'employees'} from {filename}
      </strong>{' '}
      ({report.balances} balances{report.leaveTypes.length ? `: ${report.leaveTypes.join(', ')}` : ''}).
      {report.unmatched.length ? (
        <>
          {' '}
          {report.unmatched.length} {report.unmatched.length === 1 ? 'code is not an employee' : 'codes are not employees'} here: {report.unmatched.slice(0, 10).join(', ')}
          {report.unmatched.length > 10 ? '…' : ''}.
        </>
      ) : null}
      {report.skipped ? ` ${report.skipped} rows had no leave type or balance and were skipped.` : ''}
      {report.unexplained?.length ? (
        <>
          {' '}
          {report.unexplained.join(', ')} {report.unexplained.length === 1 ? 'is' : 'are'} not in the code table, so which leave{' '}
          {report.unexplained.length === 1 ? 'it is' : 'they are'} is not known: say on <Link href="/mapping#codes">Mapping</Link>.
        </>
      ) : null}
      {report.untyped?.length ? (
        <>
          {' '}
          {report.untyped.join(', ')} {report.untyped.length === 1 ? 'is' : 'are'} mapped as Leave approved with no kind of leave:
          pick Earned, Casual, Sick or another on <Link href="/mapping">Mapping</Link> so leave taken can be told per type.
        </>
      ) : null}
    </Notice>
  );
}

/** Within this of finishing, an import is what somebody just did rather than history. */
const JUST_NOW_MS = 2 * 60_000;

/**
 * What the last attendance import did, taken from the import itself rather than
 * carried in the URL - a long message in a redirect is how this page started
 * returning headers too big for the browser to accept.
 */
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
        <strong>{row.filename} was not imported.</strong> {row.error}
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
        <strong>Nothing was read from {row.filename}.</strong> The attendance mapping on <Link href="/mapping">Mapping</Link>{' '}
        does not match it — check the column names and the date layout against the file.
        {report.rejected.length ? ` Every row was skipped: ${report.rejected[0]!.reason}.` : ''}
      </Notice>
    );
  }

  // An import that went through needs no acknowledging: it is said once, in the
  // corner, and Recent attendance imports keeps the record.
  const finished = row.finishedAt ?? row.startedAt;
  if (Date.now() - finished.getTime() > JUST_NOW_MS) return null;
  return (
    <Toast>
      Imported {report.daysImported} days for {report.employeesSeen} {report.employeesSeen === 1 ? 'employee' : 'employees'} from{' '}
      {row.filename}.{report.rejected.length ? ` ${report.rejected.length} rows skipped.` : ''}
      {report.daysHeldBack ? ` Today’s attendance was left out (${report.daysHeldBack} days), as the day is not over yet.` : ''}
      {report.daysLocked
        ? ` ${report.daysLocked} days in ${(report.lockedMonths ?? []).map((month) => monthLabel(month)).join(', ') || 'a locked month'} were skipped: that attendance is locked.`
        : ''}
      {report.employeesRestored
        ? ` ${report.employeesRestored} deleted ${report.employeesRestored === 1 ? 'employee is' : 'employees are'} back, with any cases that were kept when they were deleted.`
        : ''}
    </Toast>
  );
}
