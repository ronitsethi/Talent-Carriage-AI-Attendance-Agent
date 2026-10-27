import { redirect } from 'next/navigation';
import { withTenant } from '@/db';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { listManagers, waitingApprovals } from '@/lib/approvals';
import { caseDateLabel, formatTime } from '@/lib/display';
import { RowSwitch } from '../selection';
import { sendApprovalNow, setManagerCallMode, setManagerChannel, setManagerMode } from '@/app/actions';

const STAGE: Record<string, string> = {
  not_applied: 'Asked to apply it',
  applied: 'Applied, waiting',
  apply_for_me: 'Agent to apply it',
};

export default async function ManagersPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { rows, waiting, settings } = await withTenant(tenantId, async (tx) => ({
    rows: await listManagers(tx, tenantId),
    waiting: await waitingApprovals(tx, tenantId),
    settings: await tx.query.tenantSettings.findFirst({ where: (t, { eq }) => eq(t.tenantId, tenantId) }),
  }));

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Who approves</div>
        <h1>Managers</h1>
        <p>
          Everybody the attendance file names as a manager - by the manager mobile column, or the manager code&apos;s own mobile.
          When an employee says what happened, their manager is asked to approve the leave or regularisation, the way set here.
        </p>
      </section>

      <div className="card flush gap-below">
        <div className="card-head">
          <h2>Managers ({rows.length})</h2>
          <span className="hint">Automatic sends a request the moment it exists; Manual waits for you to send it below.</span>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Manager</th>
                  <th>Mobile</th>
                  <th className="num">Reports</th>
                  <th className="num">Waiting</th>
                  <th>Contact by</th>
                  <th>Call style</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const onCall = row.preferredChannel === 'voice';
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="employee">{row.fullName}</div>
                        <div className="sub">{row.employeeCode ? `Employee ${row.employeeCode}` : 'Not an employee in the file'}</div>
                      </td>
                      <td className="mono nowrap">+{row.mobileE164}</td>
                      <td className="num">{row.reports}</td>
                      <td className="num">
                        {row.waiting}
                        {row.unsent ? <div className="sub">{row.unsent} not sent</div> : null}
                      </td>
                      <td className="nowrap">
                        <div className="switch-group" role="group" aria-label={`Contact ${row.fullName} by`}>
                          {(['whatsapp', 'voice'] as const).map((option) => (
                            <RowSwitch key={option} action={setManagerChannel.bind(null, row.id, option)} on={row.preferredChannel === option}>
                              {option === 'voice' ? 'Call' : 'WhatsApp'}
                            </RowSwitch>
                          ))}
                        </div>
                      </td>
                      <td className="nowrap">
                        <div className={`switch-group ${onCall ? '' : 'muted'}`} role="group" aria-label="Call style" aria-disabled={!onCall}>
                          {(['keypad', 'agent'] as const).map((option) => (
                            <RowSwitch
                              key={option}
                              action={setManagerCallMode.bind(null, row.id, option)}
                              on={(row.callMode ?? settings?.callMode ?? 'keypad') === option}
                              disabled={!onCall}
                              title={!onCall ? `${row.fullName} is asked on WhatsApp - switch them to Call to choose a call style` : undefined}
                            >
                              {option === 'agent' ? 'Talk' : 'Keypad'}
                            </RowSwitch>
                          ))}
                        </div>
                      </td>
                      <td className="nowrap">
                        <div className="switch-group" role="group" aria-label="Mode">
                          {(['manual', 'automatic'] as const).map((option) => (
                            <RowSwitch key={option} action={setManagerMode.bind(null, row.id, option)} on={row.operatingMode === option}>
                              {option === 'automatic' ? 'Auto' : 'Manual'}
                            </RowSwitch>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No managers yet. They appear once an attendance file names them.</div>
        )}
      </div>

      <div className="card flush">
        <div className="card-head">
          <h2>Waiting for approval ({waiting.length})</h2>
        </div>
        {waiting.length ? (
          <div className="table-scroll">
            <table className="data small">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Date</th>
                  <th>For</th>
                  <th>Where it stands</th>
                  <th>Manager</th>
                  <th>Request</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((row) => {
                  const inputs = row.inputs as { what?: string; stage?: string; leaveType?: string };
                  return (
                    <tr key={row.id}>
                      <td>
                        <a className="row-title" href={row.caseId ? `/cases/${row.caseId}` : undefined}>
                          {row.employeeName}
                        </a>
                        <div className="sub mono">{row.employeeCode}</div>
                      </td>
                      <td className="nowrap">{row.attDate ? caseDateLabel(row.attDate, row.meaning ?? 'absent_full') : '—'}</td>
                      <td>{inputs.leaveType && inputs.what === 'leave' ? `${inputs.leaveType} leave` : inputs.what ?? '—'}</td>
                      <td>{STAGE[inputs.stage ?? ''] ?? '—'}</td>
                      <td>{row.managerName}</td>
                      <td className="nowrap">
                        {row.sentAt ? (
                          <span className="sub">Sent {formatTime(row.sentAt)}</span>
                        ) : (
                          <form action={sendApprovalNow}>
                            <input type="hidden" name="approvalId" value={row.id} />
                            <button className="btn small primary" type="submit">
                              Send now
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">Nothing is waiting on a manager.</div>
        )}
      </div>
    </>
  );
}
