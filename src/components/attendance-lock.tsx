'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

type Month = { value: string; label: string };

/**
 * "Unlock attendance": asks which of the locked months to unlock, several at
 * once if wanted, before anything changes.
 */
export function UnlockMonths({ months, action }: { months: Month[]; action: (formData: FormData) => void | Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const toggle = (value: string, on: boolean) => setPicked((now) => (on ? [...now, value] : now.filter((v) => v !== value)));

  return (
    <>
      <button className="btn" type="button" disabled={!months.length} onClick={() => dialog.current?.showModal()}>
        Unlock attendance
      </button>
      <dialog className="modal" ref={dialog} aria-labelledby="unlock-months" onClose={() => setPicked([])}>
        <h2 id="unlock-months">Unlock attendance</h2>
        <form action={action} onSubmit={() => setBusy(true)}>
          <div className="modal-body">
            <p>Select the month you want to unlock attendance for:</p>
            <div className="month-picks">
              {months.map((month) => (
                <label key={month.value} className="month-pick">
                  <input
                    type="checkbox"
                    name="month"
                    value={month.value}
                    checked={picked.includes(month.value)}
                    onChange={(event) => toggle(month.value, event.target.checked)}
                  />
                  {month.label}
                </label>
              ))}
            </div>
            <p className="hint">
              Each case goes back to where it was when the month was locked, and uploads for the month are accepted again.
            </p>
          </div>
          <div className="modal-foot">
            <button className="btn" type="button" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button className="btn primary" type="submit" disabled={!picked.length || busy}>
              {busy ? 'Unlocking…' : picked.length > 1 ? `Unlock ${picked.length} months` : 'Unlock'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/**
 * The question after unlocking, for a customer on automatic: send what is now
 * due, or just unlock. The months are already unlocked, so closing it any way
 * but Send means "just unlock".
 */
export function UnlockChoice({
  months,
  action,
  children,
}: {
  months: string;
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const justUnlock = () => {
    dialog.current?.close();
    router.replace('/mapping', { scroll: false });
  };

  return (
    <dialog className="modal" ref={dialog} aria-labelledby="unlock-choice" onCancel={justUnlock}>
      <h2 id="unlock-choice">Attendance unlocked</h2>
      <div className="modal-body">{children}</div>
      <form action={action} onSubmit={() => setBusy(true)}>
        <input type="hidden" name="months" value={months} />
        <div className="modal-foot">
          <button className="btn" type="button" onClick={justUnlock}>
            Just unlock
          </button>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Starting…' : 'Send'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
