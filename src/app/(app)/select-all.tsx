'use client';

import { useEffect, useRef } from 'react';

/**
 * The header tick box: selects or clears every row in the same form.
 *
 * It also reflects the rows - ticked when all are, cleared when none are, and
 * half-filled in between - so it never claims a state the table does not have.
 */
export function SelectAll({ initiallyChecked, signature }: { initiallyChecked: boolean; signature: string }) {
  const ref = useRef<HTMLInputElement>(null);

  const rowBoxes = (): HTMLInputElement[] => {
    const form = ref.current?.closest('form');
    return form ? Array.from(form.querySelectorAll<HTMLInputElement>('input[name="target"]')) : [];
  };

  const reflectRows = () => {
    const boxes = rowBoxes();
    const checked = boxes.filter((box) => box.checked).length;
    if (!ref.current) return;
    ref.current.checked = boxes.length > 0 && checked === boxes.length;
    ref.current.indeterminate = checked > 0 && checked < boxes.length;
  };

  // A tick box is uncontrolled, so it keeps whatever the user last did to it -
  // including across a change of date range, where the rows are replaced but
  // this element is not. `signature` changes with the table, which forces the
  // header to be read back from the rows instead of showing a stale state.
  useEffect(() => {
    reflectRows();
    const boxes = rowBoxes();
    boxes.forEach((box) => box.addEventListener('change', reflectRows));
    return () => boxes.forEach((box) => box.removeEventListener('change', reflectRows));
  }, [signature]);

  return (
    <input
      ref={ref}
      type="checkbox"
      defaultChecked={initiallyChecked}
      aria-label="Select all rows"
      title="Select or clear every row"
      onChange={(event) => {
        for (const box of rowBoxes()) box.checked = event.target.checked;
      }}
    />
  );
}
