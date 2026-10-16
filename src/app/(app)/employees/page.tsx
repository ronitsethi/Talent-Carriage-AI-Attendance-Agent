import Link from 'next/link';
import { redirect } from 'next/navigation';
import { canManageSettings, getActiveTenantId, getSession } from '@/lib/auth';
import { listEmployees, tenantSummary } from '@/lib/queries';
import { Notice } from '@/components/notice';
import { ConfirmSubmit } from '@/components/confirm';
import { deleteEmployee } from '@/app/actions';

/**
 * Everyone this customer employs, and the one place they can be removed.
 *
 * Deleting is asked about rather than done, because what happens to the cases
 * they are in the middle of is a decision only HR can make - and the dialog is
 * where that decision is put.
 */
export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; deleted?: string; kept?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) return <p style={{ paddingTop: 40 }}>No customer selected.</p>;

  const [{ tenant }, { q, deleted, kept }] = await Promise.all([tenantSummary(tenantId), searchParams]);
  // Deleting is as far-reaching as a settings change, so it asks for the same
  // standing. Everyone else reads the list.
  const canDelete = canManageSettings(session);
  const search = q?.trim() ?? '';
  const people = await listEmployees(tenantId, { search });

  const count = (n: number, singular: string) => `${n} ${singular}${n === 1 ? '' : 's'}`;

  return (
    <>
      {deleted ? (
        <Notice tone="ok" clear={['deleted', 'kept']}>
          <strong>{deleted}</strong> has been deleted.{' '}
          {kept ? (
            <>
              Their {count(Number(kept), 'open case')} {Number(kept) === 1 ? 'is' : 'are'} kept as a record in{' '}
              <Link href="/cases">Follow-up cases</Link> — nothing more will be sent about{' '}
              {Number(kept) === 1 ? 'it' : 'them'}.
            </>
          ) : (
            'Everything of theirs has been removed.'
          )}
        </Notice>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">People on file</div>
        <h1>Employees</h1>
        <p>
          Everyone imported for {tenant?.name}. Who is contacted, how, and on whose say-so — all of it is set against
          one of these rows. Deleting somebody stops every message and call to them, until an attendance file has them
          in it again.
        </p>
      </section>

      <div className="card flush">
        <form className="toolbar" method="get">
          <div className="field" style={{ minWidth: 220, flex: 1, maxWidth: 320 }}>
            <label htmlFor="q">Employee</label>
            <input className="input" id="q" name="q" placeholder="Name or code" defaultValue={search} />
          </div>
          <button className="btn" type="submit">
            Filter
          </button>
          {search ? (
            <Link className="btn quiet" href="/employees">
              Reset
            </Link>
          ) : null}
          <span className="toolbar-end toolbar-count">{count(people.length, 'employee')}</span>
        </form>

        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Department</th>
                <th>Mobile</th>
                <th>Contact by</th>
                <th>Mode</th>
                <th className="num">Open cases</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.length ? (
                people.map((person) => (
                  <tr key={person.id}>
                    <td>
                      <div className="employee">{person.fullName}</div>
                      <div className="sub mono">{person.empCode}</div>
                    </td>
                    <td>{person.department ?? '—'}</td>
                    <td className="nowrap mono">{person.mobile ? `+${person.mobile}` : <span className="sub">None</span>}</td>
                    <td className="nowrap">
                      {person.preferredChannel === 'voice'
                        ? `Call · ${person.callMode === 'agent' ? 'Talk' : 'Keypad'}`
                        : 'WhatsApp'}
                    </td>
                    <td className="nowrap">
                      {person.operatingMode ? (
                        person.operatingMode === 'automatic' ? (
                          'Auto'
                        ) : (
                          'Manual'
                        )
                      ) : (
                        <span className="sub" title="Following the customer default">
                          Default
                        </span>
                      )}
                    </td>
                    <td className="num mono">
                      {person.openCases ? (
                        <Link href={`/cases?status=open&q=${encodeURIComponent(person.empCode)}`}>{person.openCases}</Link>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="nowrap end">
                      {!canDelete ? null : (
                        <form action={deleteEmployee}>
                          <input type="hidden" name="employeeId" value={person.id} />
                          <ConfirmSubmit
                            label="Delete"
                            className="btn small danger"
                            tone="danger"
                            title={`Delete ${person.fullName}?`}
                            confirmLabel="Delete employee"
                            message={
                              <>
                                <p>
                                  They come off the dashboard, out of the daily check, and off every channel: nothing is
                                  sent to them again, and nothing they send is acted on.
                                </p>
                                <p>
                                  Deleted with them: {count(person.attendanceDays, 'attendance day')} and{' '}
                                  {count(person.otherCases, 'finished or unsent case')}.
                                </p>
                                <p>
                                  If a later attendance file has them in it, they come back{' '}
                                  {person.openCases ? 'with whatever is kept below' : 'as a new employee'}.
                                </p>
                              </>
                            }
                            options={
                              person.openCases
                                ? [
                                    {
                                      name: 'deleteOpenCases',
                                      label: `Also delete their ${count(person.openCases, 'open case')}`,
                                      hint: 'Leave this unticked and those cases stay in Follow-up cases as a record — readable, but no calls, messages, reset or closing until an import brings this person back.',
                                    },
                                  ]
                                : undefined
                            }
                          />
                        </form>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty" colSpan={7}>
                    {search ? `Nobody matches "${search}".` : 'No employees have been imported yet.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
