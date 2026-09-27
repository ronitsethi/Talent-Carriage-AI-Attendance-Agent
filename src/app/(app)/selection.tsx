'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

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
  selectedCount: number;
};

const SelectionContext = createContext<Selection | null>(null);

/**
 * The rows come from the server, so the initial selection is known up front -
 * no registering during render, which React drops.
 *
 * Give this a `key` that changes with the table (the page does) and a new table
 * starts from its own defaults rather than inheriting the last one's ticks.
 */
export function SelectionProvider({
  rows,
  children,
}: {
  rows: { value: string; selected: boolean }[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [row.value, row.selected])),
  );

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
      selectedCount: keys.filter((key) => selected[key]).length,
    };
  }, [selected, toggle, setAll]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): Selection {
  const context = useContext(SelectionContext);
  if (!context) throw new Error('Selection components must sit inside a SelectionProvider');
  return context;
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

/** The header tick box: selects or clears every row, and reflects their state. */
export function SelectAll() {
  const { total, selectedCount, setAll } = useSelection();
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
