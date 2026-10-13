'use client';

import { useState } from 'react';

/**
 * A file input drawn as a drop zone.
 *
 * The real input lies over the whole zone, invisible, so clicking anywhere on
 * it opens the picker and dropping a file on it fills it in - no handlers of our
 * own, and `required` still stops an empty upload. All this adds is saying
 * which file was chosen, which the hidden input no longer shows.
 */
export function FileDrop({
  id,
  name,
  accept,
  label,
  hint,
  required,
  tall,
}: {
  id: string;
  name: string;
  accept: string;
  label: string;
  /** The formats it takes, shown in mono: ".xlsx .xls .csv". */
  hint: string;
  required?: boolean;
  tall?: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <label className={`dropzone${tall ? ' tall' : ''}${chosen ? ' chosen' : ''}`} htmlFor={id}>
      {tall ? null : <span className="dropzone-hint">{hint}</span>}
      <span className="dropzone-label">{chosen ?? label}</span>
      {tall ? <span className="dropzone-hint">{hint}</span> : null}
      <input
        type="file"
        id={id}
        name={name}
        accept={accept}
        required={required}
        onChange={(event) => setChosen(event.target.files?.[0]?.name ?? null)}
      />
    </label>
  );
}
