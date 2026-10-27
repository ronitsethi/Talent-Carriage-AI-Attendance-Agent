'use client';

import { useMemo, useState } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * A query's ticket as the AI wrote it, for HR to correct. Every field can be
 * changed; nothing is saved until Save is pressed, and Discard puts back what
 * was there.
 */

type Option = { id: string; label: string };
export type TicketValues = {
  queryTypeId: string;
  priority: string;
  description: string;
  assignedPersonId: string;
  ltTransferred: 'yes' | 'no';
  ltPersonId: string;
};

const PRIORITY_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary" type="submit" disabled={disabled || pending}>
      {pending ? 'Saving…' : 'Save changes'}
    </button>
  );
}

export function TicketForm({
  queryId,
  initial,
  types,
  people,
  staleType,
  assignmentNote,
  action,
}: {
  queryId: string;
  initial: TicketValues;
  types: (Option & { coe: string })[];
  people: Option[];
  /** A type the ticket was filed under that the current sheet no longer has. */
  staleType: string | null;
  /** Why the AI's choice of assignee is out of the ordinary, if it is. */
  assignmentNote: string | null;
  action: (formData: FormData) => Promise<void>;
}) {
  const [values, setValues] = useState(initial);
  const dirty = useMemo(() => (Object.keys(initial) as (keyof TicketValues)[]).some((key) => values[key] !== initial[key]), [values, initial]);
  const set = <K extends keyof TicketValues>(key: K, value: TicketValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <form action={action} className="ticket-form">
      <input type="hidden" name="queryId" value={queryId} />

      <label className="ticket-label" htmlFor="ticket-type">
        Query type
      </label>
      <div>
        <select id="ticket-type" name="queryTypeId" className="input" value={values.queryTypeId} onChange={(e) => set('queryTypeId', e.target.value)}>
          <option value="">{staleType ? `${staleType} (no longer in the sheet)` : 'No matching query type'}</option>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label} · {type.coe}
            </option>
          ))}
        </select>
      </div>

      <label className="ticket-label" htmlFor="ticket-priority">
        Priority
      </label>
      <div>
        <select id="ticket-priority" name="priority" className="input" value={values.priority} onChange={(e) => set('priority', e.target.value)}>
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <label className="ticket-label" htmlFor="ticket-description">
        Description of the problem
      </label>
      <div>
        <textarea
          id="ticket-description"
          name="description"
          className="input textarea"
          rows={6}
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </div>

      <label className="ticket-label" htmlFor="ticket-assignee">
        Assigned to
      </label>
      <div>
        <select
          id="ticket-assignee"
          name="assignedPersonId"
          className="input"
          value={values.assignedPersonId}
          onChange={(e) => set('assignedPersonId', e.target.value)}
        >
          <option value="">Not assigned</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </select>
        {assignmentNote && values.assignedPersonId === initial.assignedPersonId ? <p className="ticket-mark">{assignmentNote}</p> : null}
      </div>

      <span className="ticket-label" id="ticket-lt-label">
        Transferred to LT person
      </span>
      <div className="ticket-lt" role="group" aria-labelledby="ticket-lt-label">
        <select
          name="ltTransferred"
          className="input"
          aria-label="Transferred to LT person"
          value={values.ltTransferred}
          onChange={(e) => set('ltTransferred', e.target.value as 'yes' | 'no')}
        >
          <option value="no">No</option>
          <option value="yes">Yes</option>
        </select>
        <select
          name="ltPersonId"
          className="input"
          aria-label="LT person"
          value={values.ltPersonId}
          disabled={values.ltTransferred === 'no'}
          onChange={(e) => set('ltPersonId', e.target.value)}
        >
          <option value="">Choose the LT person</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </select>
        {/* A disabled select is not submitted; keep its value for when it is switched back on. */}
        {values.ltTransferred === 'no' ? <input type="hidden" name="ltPersonId" value="" /> : null}
      </div>

      <div className="ticket-actions">
        <button type="button" className="btn" disabled={!dirty} onClick={() => setValues(initial)}>
          Discard
        </button>
        <SaveButton disabled={!dirty} />
      </div>
    </form>
  );
}
