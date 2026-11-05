'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The question after an attendance upload: send what is due, or stop here.
 *
 * It opens by itself, because the upload has finished and is waiting on nothing
 * else. The attendance is already saved, so closing it any way but the send
 * button simply means "just update the attendance".
 */
export function UploadChoice({
  importId,
  action,
  children,
}: {
  importId: string;
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  const justUpdate = () => {
    dialog.current?.close();
    router.replace('/mapping', { scroll: false });
  };

  return (
    <dialog className="modal" ref={dialog} aria-labelledby="upload-choice" onCancel={justUpdate}>
      <h2 id="upload-choice">Attendance updated</h2>
      <div className="modal-body">{children}</div>
      <form action={action} onSubmit={() => setBusy(true)}>
        <input type="hidden" name="importId" value={importId} />
        <div className="modal-foot" style={{ flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={justUpdate}>
            Just update attendance data
          </button>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Starting…' : "Send today's calls/messages"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
