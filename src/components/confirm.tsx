'use client';

import { useId, useRef, useState, type ReactNode } from 'react';

/**
 * A button that asks before it submits.
 *
 * Everything on this platform that reaches an employee - a first message, a
 * call, a day-2 reminder - goes through one of these, because the action cannot
 * be taken back once a phone has rung. So does deleting someone.
 *
 * The dialog is a native `<dialog>`, opened with `showModal()`: the browser
 * centres it, dims the page, traps the focus and closes it on Escape, and the
 * top layer puts it above everything whatever table cell it was declared in.
 * It stays inside its form, so a tick box in it is submitted with the rest.
 */
export function ConfirmSubmit({
  label,
  className = 'btn',
  title,
  message,
  confirmLabel,
  tone = 'primary',
  formAction,
  options,
  disabled,
}: {
  /** What the page shows before anything is asked. */
  label: ReactNode;
  className?: string;
  title: string;
  message: ReactNode;
  /** The button that goes through with it; say what it does, not "OK". */
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** For a form whose default action is something else, as on the dashboard. */
  formAction?: (formData: FormData) => void | Promise<void>;
  /** Tick boxes that change what the action does. Submitted with the form. */
  options?: { name: string; label: string; hint?: string; defaultChecked?: boolean }[];
  disabled?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => dialog.current?.showModal()}>
        {label}
      </button>

      <dialog className="modal" ref={dialog} aria-labelledby={headingId}>
        <h2 id={headingId}>{title}</h2>
        <div className="modal-body">{message}</div>

        {options?.length ? (
          <div className="modal-options">
            {options.map((option) => (
              <label key={option.name} className="modal-option">
                <input type="checkbox" name={option.name} defaultChecked={option.defaultChecked} />
                <span>
                  {option.label}
                  {option.hint ? <span className="sub">{option.hint}</span> : null}
                </span>
              </label>
            ))}
          </div>
        ) : null}

        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${tone}`}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              // Closing first leaves the tick boxes in the DOM, so they are
              // still part of the form being submitted.
              dialog.current?.close();
              submit.current?.click();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>

      {/* The real submit button. Clicking it is what names the action, which is
          how a form with several `formAction` buttons submits the right one. */}
      <button type="submit" ref={submit} formAction={formAction} className="sr-only" tabIndex={-1} aria-hidden />
    </>
  );
}
