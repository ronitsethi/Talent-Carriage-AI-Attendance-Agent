'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition, type ReactNode } from 'react';
import { ConfirmSubmit } from '@/components/confirm';

/**
 * Row selection for the dashboard table.
 *
 * Earlier versions let the browser own the tick boxes and tried to read them
 * back into the header. That loses races with React: when a switch is pressed
 * the table re-renders, and the header would end up describing a table that no
 * longer existed. Here React owns the selection, so the header and the rows can
 * never disagree.
 */

type Selection = {
  isSelected: (value: string) => boolean;
  toggle: (value: string, selected: boolean) => void;
  setAll: (selected: boolean) => void;
  total: number;
  /** The ticked rows, as "employeeId|date" - what the server action receives. */
  selectedValues: string[];
};

const SelectionContext = createContext<Selection | null>(null);

/**
 * The ticks, kept per table outside React.
 *
 * Pressing a switch on a row asks the server to change that person, and the
 * page re-renders around this component. React usually keeps its state through
 * that - but when it does not, the ticks are silently back to their defaults
 * and the next press of Contact goes to the wrong people. Too quiet a way to
 * message the wrong employee, so the ticks are kept here instead, under the
 * signature of the table they belong to; a different table starts clean.
 */
const remembered = new Map<string, Record<string, boolean>>();

/**
 * The rows come from the server, so the initial selection is known up front -
 * no registering during render, which React drops.
 *
 * `signature` says which table these rows are; give this a `key` that changes
 * with it (the page does) and a new table starts from its own defaults rather
 * than inheriting the last one's ticks.
 */
export function SelectionProvider({
  signature,
  rows,
  children,
}: {
  signature: string;
  rows: { value: string; selected: boolean }[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(
    () => remembered.get(signature) ?? Object.fromEntries(rows.map((row) => [row.value, row.selected])),
  );

  // Only the table on screen is worth remembering.
  useEffect(() => {
    remembered.clear();
    remembered.set(signature, selected);
  }, [signature, selected]);

  const toggle = useCallback((value: string, isSelected: boolean) => {
    setSelected((current) => ({ ...current, [value]: isSelected }));
  }, []);

  const setAll = useCallback((isSelected: boolean) => {
    setSelected((current) => Object.fromEntries(Object.keys(current).map((key) => [key, isSelected])));
  }, []);

  const value = useMemo<Selection>(() => {
    const keys = Object.keys(selected);
    return {
      isSelected: (key: string) => selected[key] ?? false,
      toggle,
      setAll,
      total: keys.length,
      selectedValues: keys.filter((key) => selected[key]),
    };
  }, [selected, toggle, setAll]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): Selection {
  const context = useContext(SelectionContext);
  if (!context) throw new Error('Selection components must sit inside a SelectionProvider');
  return context;
}

/**
 * One switch on a row - WhatsApp or Call, Keypad or Talk, Manual or Auto.
 *
 * It is deliberately not a submit button: these sit inside the form that
 * carries the bulk Contact, and submitting that form to change one person's
 * channel took the tick boxes with it. The action is called on its own, and
 * what is ticked stays ticked.
 */
export function RowSwitch({
  action,
  on,
  disabled = false,
  title,
  children,
}: {
  action: () => Promise<void>;
  on: boolean;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className={`switch-option ${on ? 'on' : ''}`}
      aria-pressed={on}
      disabled={disabled || pending}
      title={title}
      onClick={() => {
        // Pressing the lit side is a no-op: these choose between two, they do
        // not toggle, so there is nothing to ask the server for.
        if (on) return;
        startTransition(async () => {
          await action();
        });
      }}
    >
      {children}
    </button>
  );
}

/** One row's tick box. Its value is what the server action receives. */
export function RowCheckbox({ value }: { value: string }) {
  const { isSelected, toggle } = useSelection();

  return (
    <input
      type="checkbox"
      name="target"
      value={value}
      checked={isSelected(value)}
      onChange={(event) => toggle(value, event.target.checked)}
    />
  );
}

/**
 * The bulk send, with the count beside it and a question before it.
 *
 * Pressing this rings phones, so it says exactly how many and whose before
 * anything goes out - the one thing on this page that cannot be undone.
 */
export function ContactSelected() {
  const { selectedValues } = useSelection();
  const people = new Set(selectedValues.map((value) => value.split('|')[0])).size;
  const dates = selectedValues.length;
  const one = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`;

  return (
    <>
      <span className="selected-count">{dates} selected</span>
      <ConfirmSubmit
        label="Contact selected"
        className="btn primary"
        disabled={!dates}
        title={`Contact ${one(people, 'person', 'people')}?`}
        message={
          <>
            <p>
              <strong>{one(people, 'person', 'people')}</strong> will be messaged or called about{' '}
              <strong>{one(dates, 'date', 'dates')}</strong>, on whichever channel each of them is set to. Someone with
              several dates ticked is contacted once; the call or chat sweeps the rest.
            </p>
            <p>This goes out straight away and cannot be taken back.</p>
          </>
        }
        confirmLabel="Contact them"
      />
    </>
  );
}

/** The header tick box: selects or clears every row, and reflects their state. */
export function SelectAll() {
  const { total, selectedValues, setAll } = useSelection();
  const selectedCount = selectedValues.length;
  const allSelected = total > 0 && selectedCount === total;

  return (
    <input
      type="checkbox"
      aria-label="Select all rows"
      title="Select or clear every row"
      checked={allSelected}
      ref={(node) => {
        if (node) node.indeterminate = selectedCount > 0 && selectedCount < total;
      }}
      onChange={(event) => setAll(event.target.checked)}
    />
  );
}
