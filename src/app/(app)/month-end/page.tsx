import { redirect } from 'next/navigation';
import { canManageSettings, getActiveTenantId, getSession } from '@/lib/auth';
import { monthEndOverview } from '@/lib/queries';
import { formatTime } from '@/lib/display';
import { monthLabel } from '@/lib/locks';
import Link from 'next/link';
import { uploadPayroll } from '@/app/actions';
import { AttendanceLockCard, type LockParams } from '@/components/attendance-lock-card';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import type { PayrollReport } from '@/db/schema';

/**
 * Month end: a month's attendance is locked once it is final, and only then can
 * its payroll go in - once. The agent answers salary questions from the two
 * together. Final attendance and payroll can be downloaded month by month.
 */
export default async function MonthEndPage({
  searchParams,
}: {
  searchParams: Promise<LockParams & { problem?: string; payroll?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');
  const admin = canManageSettings(session);
  const params = await searchParams;
  const { months, mapped } = await monthEndOverview(tenantId);
  // A locked month with no payroll yet is the only kind that can take one.
  const open = months.filter((m) => m.lock && !m.payroll).map((m) => m.month);
  const imported = params.payroll ? months.find((m) => m.month === params.payroll)?.payroll ?? null : null;

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Month end</div>
        <h1>Month end</h1>
        <p>
          Lock a month&apos;s attendance once it is final, then upload that month&apos;s payroll. The agent answers salary
          questions from both. Final attendance and payroll can be downloaded for any month here.
        </p>
      </section>

      {params.problem ? (
        <Notice tone="err" clear={['problem']}>
          {params.problem}
        </Notice>
      ) : null}
      {imported?.report ? <PayrollOutcome month={imported.month} report={imported.report} /> : null}

      <AttendanceLockCard tenantId={tenantId} admin={admin} params={params} />

      <section className="card pad gap-above" id="payroll">
        <div className="section-head">
          <h2>Payroll</h2>
        </div>
        <p className="card-desc">
          One payroll file per month, uploaded after that month&apos;s attendance is locked, and read with the payroll
          mapping set up on Mapping &amp; import. Only an employee&apos;s own row is read to them when they ask. PAN, Aadhaar and
          bank details are never kept.{admin ? '' : ' Only an admin can upload payroll.'}
        </p>

        {admin && !mapped ? (
          <p className="hint">
            Set up the payroll mapping on <Link href="/mapping#payroll-mapping">Mapping &amp; import</Link> first: which
            column of the payroll file is which, as for attendance. Payroll can be uploaded once it is saved.
          </p>
        ) : admin ? (
          open.length ? (
            <form action={uploadPayroll} className="upload-row payroll-upload">
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="payroll-month">Month</label>
                <select className="input" id="payroll-month" name="month" defaultValue={open[0]}>
                  {open.map((month) => (
                    <option key={month} value={month}>
                      {monthLabel(month)}
                    </option>
                  ))}
                </select>
              </div>
              <FileDrop id="payroll-file" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Choose payroll file" required />
              <button className="btn primary lg" type="submit">
                Upload payroll
              </button>
            </form>
          ) : (
            <p className="hint">
              {months.some((m) => m.lock)
                ? 'Every locked month already has its payroll. Lock the next month above to upload its payroll.'
                : 'Lock a month’s attendance above first. Its payroll can be uploaded once it is locked.'}
            </p>
          )
        ) : null}
      </section>

      <section className="card flush gap-above">
        <div className="card-head">
          <h2>Months</h2>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Month</th>
                <th>Attendance</th>
                <th>Payroll</th>
                <th>Download</th>
              </tr>
            </thead>
            <tbody>
              {months.length ? (
                months.map(({ month, lock, payroll }) => (
                  <tr key={month}>
                    <td className="nowrap">
                      <strong>{monthLabel(month, new Date(0))}</strong>
                    </td>
                    <td>{lock ? <>Locked {formatTime(lock.lockedAt)}</> : <span className="sub">Not locked</span>}</td>
                    <td>
                      {payroll ? (
                        <>
                          Uploaded {formatTime(payroll.uploadedAt)}
                          <div className="sub">
                            {payroll.report?.matched ?? 0} employees
                            {payroll.report?.unmatched.length ? ` · ${payroll.report.unmatched.length} codes not found` : ''}
                            {payroll.report?.warnings.length ? ` · ${payroll.report.warnings.length} to check` : ''}
                          </div>
                        </>
                      ) : (
                        <span className="sub">Not uploaded</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <div className="btn-row" style={{ gap: 6 }}>
                        {lock ? (
                          <a className="btn small" href={`/api/exports/attendance?month=${month}`}>
                            Final attendance
                          </a>
                        ) : (
                          <span className="sub">Lock to download</span>
                        )}
                        {payroll && admin ? (
                          <a className="btn small" href={`/api/exports/payroll?month=${month}`}>
                            Payroll
                          </a>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty" colSpan={4}>
                    No attendance has been imported yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** What a payroll upload found: who matched, and what to check against the attendance. */
function PayrollOutcome({ month, report }: { month: string; report: PayrollReport }) {
  return (
    <Notice tone={report.unmatched.length || report.warnings.length ? 'info' : 'ok'} clear={['payroll']}>
      <strong>
        {monthLabel(month)}&apos;s payroll is in: {report.matched} of {report.rows} employees matched.
      </strong>
      {report.unmatched.length ? (
        <> {report.unmatched.length} codes are not employees here, so nobody can be told about those rows: {report.unmatched.slice(0, 10).join(', ')}{report.unmatched.length > 10 ? '…' : ''}.</>
      ) : null}
      {report.dropped.length ? <> Not kept: {report.dropped.join(', ')}.</> : null}
      {report.warnings.length ? (
        <details className="payroll-warnings">
          <summary>
            {report.warnings.length} {report.warnings.length === 1 ? 'row does' : 'rows do'} not match the locked attendance — check
          </summary>
          <ul>
            {report.warnings.slice(0, 50).map((warning, index) => (
              <li key={index}>
                <strong>
                  {warning.name ?? warning.empCode} ({warning.empCode})
                </strong>{' '}
                {warning.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Notice>
  );
}
