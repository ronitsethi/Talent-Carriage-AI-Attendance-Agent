import { lockAttendance, sendAfterUnlock, unlockAttendance } from '@/app/actions';
import { ConfirmSubmit } from '@/components/confirm';
import { UnlockChoice, UnlockMonths } from '@/components/attendance-lock';
import { Toast } from '@/components/toast';
import { formatTime } from '@/lib/display';
import { monthLabel } from '@/lib/locks';
import { attendanceLockOverview } from '@/lib/queries';
import { previewUnlockSend } from '@/lib/upload-send';

const startsIn = (minutes: number) => (minutes ? `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : 'now');

/** What the lock and unlock actions say when they come back to the page. */
export type LockParams = { locked?: string; moved?: string; unlocked?: string; restored?: string; scheduled?: string; after?: string };

/**
 * Locking a month's attendance, and unlocking months: the card, and what is
 * said after each. Only an admin sees the buttons. After unlocking, a customer
 * on automatic is asked whether to send what is now due.
 */
export async function AttendanceLockCard({ tenantId, admin, params }: { tenantId: string; admin: boolean; params: LockParams }) {
  const locks = await attendanceLockOverview(tenantId);
  const { locked, moved, unlocked, restored, scheduled, after } = params;
  const unlockedMonths = (unlocked ?? '').split(',').filter(Boolean);
  const choice = unlockedMonths.length ? await previewUnlockSend(tenantId, unlockedMonths) : null;
  const unlockedNames = unlockedMonths.map((month) => monthLabel(month)).join(', ');

  return (
    <>
      {locked ? (
        <Toast clear={['locked', 'moved']}>
          {monthLabel(locked)}&apos;s attendance is locked.{' '}
          {Number(moved) ? `${moved} open ${Number(moved) === 1 ? 'case' : 'cases'} moved to Unresolved.` : 'No case was open.'}
        </Toast>
      ) : null}
      {unlockedMonths.length && !choice?.people ? (
        <Toast clear={['unlocked', 'restored']}>
          Attendance unlocked for {unlockedNames}.{' '}
          {Number(restored) ? `${restored} ${Number(restored) === 1 ? 'case is' : 'cases are'} back where they were.` : ''}
        </Toast>
      ) : null}
      {scheduled ? (
        <Toast clear={['scheduled', 'after']}>
          {Number(scheduled)
            ? `${scheduled} ${Number(scheduled) === 1 ? 'person' : 'people'} will be contacted, starting ${startsIn(Number(after))}.`
            : 'Nobody is due a call or message.'}
        </Toast>
      ) : null}
      {unlockedMonths.length && choice?.people ? (
        <UnlockChoice months={unlockedMonths.join(',')} action={sendAfterUnlock} back="/month-end">
          <p>
            Attendance unlocked for {unlockedNames}. Do you want to send the{' '}
            <strong>
              {choice.firstContact} unopened absence calls/messages and {choice.followUps}{' '}
              {choice.followUps === 1 ? 'follow-up' : 'follow-ups'}
            </strong>
            ? They start {startsIn(choice.delayMinutes)}.
          </p>
          {choice.sendingEnabled ? null : (
            <p>
              <strong>Sending is switched off above, so nothing would reach anyone.</strong>
            </p>
          )}
        </UnlockChoice>
      ) : null}

      <section className="card pad lock-card" id="attendance-lock">
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
    </>
  );
}
