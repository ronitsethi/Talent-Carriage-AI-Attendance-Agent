'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { SheetUploadState } from '@/app/actions';
import { FileDrop } from '@/components/file-drop';

/** Uploads the training sheet. Replaces the query types with the sheet's; says what changed, or what is wrong. */

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary lg" type="submit" disabled={pending}>
      {pending ? 'Reading…' : 'Upload sheet'}
    </button>
  );
}

export function QueryTypeUpload({ action }: { action: (state: SheetUploadState, formData: FormData) => Promise<SheetUploadState> }) {
  const [state, submit] = useActionState(action, null);
  return (
    <form action={submit} className="sheet-upload">
      <div className="upload-row">
        <FileDrop id="sheet" name="sheet" accept=".xlsx,.xls" hint=".xlsx .xls" label="Choose the training sheet" required />
        <UploadButton />
      </div>
      {state && 'summary' in state ? (
        <p className="sheet-upload-ok" role="status">
          Updated: {state.summary}.
        </p>
      ) : null}
      {state && 'errors' in state ? (
        <div className="notice err inline" role="alert">
          <div className="notice-body">
            <strong>Nothing was changed.</strong>
            <ul className="coe-errors">
              {state.errors.slice(0, 12).map((error) => (
                <li key={error}>{error}</li>
              ))}
              {state.errors.length > 12 ? <li>…and {state.errors.length - 12} more.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </form>
  );
}
