'use client';

import { useState } from 'react';
import { PLATFORM_FIELDS, REQUIRED_FIELDS, type PlatformField } from '@/lib/mapping/apply';
import { ALL_MEANINGS, type Meaning } from '@/lib/mapping/meanings';
import { meaningLabel } from '@/lib/display';

/**
 * The mapping, as a form you fill in.
 *
 * This is configuration, not a file-reading exercise. Somebody holding their
 * customer's column names and code list can enter the whole thing here before a
 * single file arrives, and can come back and change it afterwards. Uploading a
 * file only fills these boxes in as a convenience; it is never how the mapping
 * is made.
 */

const FIELD_LABELS: Record<PlatformField, string> = {
  employee_code: 'Employee code',
  employee_name: 'Employee name',
  mobile: 'Mobile number',
  attendance_status: 'Attendance status',
  email: 'Email',
  department: 'Department',
  branch: 'Branch',
  location: 'Location',
  designation: 'Designation',
  shift_code: 'Shift',
  calendar_code: 'Calendar',
  manager_ref: 'Manager (code)',
  manager_mobile: 'Manager mobile',
  date_of_joining: 'Date of joining',
  exit_date: 'Exit date',
  employment_status: 'Employment status',
  language: 'Language',
};

const FIELD_NOTES: Partial<Record<PlatformField, string>> = {
  employee_name: 'Two columns? Separate with a comma: First Name, Last Name',
  attendance_status: 'Only when their file has a row for each day',
  manager_ref: "The manager's employee code, not their name",
  exit_date: 'Stops the agent ever ringing somebody who has left',
};

export type CodeRow = { code: string; meaning: Meaning; chase: boolean };

export type MappingDraft = {
  name: string;
  hrmsHint: string;
  layout: 'column_per_day' | 'row_per_day';
  dateColumn: string;
  headerPattern: string;
  year: string;
  separator: string;
  fields: Partial<Record<PlatformField, string>>;
  codes: CodeRow[];
};

const DAY_THEN_MONTH = '^\\s*(\\d{1,2})\\s*[/-]\\s*(\\d{1,2})';
const DAY_ONLY = '^\\s*(?<day>\\d{1,2})\\s*$';
const DAY_THEN_NAME = '^\\s*(?<day>\\d{1,2})[-/](?<month>[A-Za-z]{3})';

export function MappingForm({
  initial,
  suggestions = [],
  heading,
  note,
  resolvedYear,
}: {
  initial: MappingDraft;
  /** The year the last import actually used, when none is pinned. */
  resolvedYear?: number | null;
  /** Headings seen in a real file, offered as you type. Never a limit. */
  suggestions?: string[];
  heading: string;
  note: string;
}) {
  const [layout, setLayout] = useState(initial.layout);
  const [separator, setSeparator] = useState(initial.separator);
  const [codes, setCodes] = useState<CodeRow[]>(
    initial.codes.length ? initial.codes : [{ code: '', meaning: 'absent_full', chase: false }],
  );

  const setCode = (index: number, patch: Partial<CodeRow>) =>
    setCodes((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="card pad">
      <div className="section-head">
        <h2>{heading}</h2>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 18 }}>
        {note}
      </p>

      <datalist id="known-columns">
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="row" style={{ padding: 0, marginBottom: 18 }}>
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor="name">Name this mapping</label>
          <input
            className="input"
            id="name"
            name="name"
            defaultValue={initial.name}
            placeholder="e.g. Aastha monthly register"
          />
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="hrmsHint">Which HRMS (optional)</label>
          <input
            className="input"
            id="hrmsHint"
            name="hrmsHint"
            defaultValue={initial.hrmsHint}
            placeholder="TimeOffice, greytHR…"
          />
        </div>
      </div>

      <h3 style={{ fontSize: 15, margin: '20px 0 8px' }}>How their file lays out the dates</h3>
      <div className="switch-group" style={{ marginBottom: 12 }}>
        {(['column_per_day', 'row_per_day'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`switch-option ${layout === option ? 'on' : ''}`}
            onClick={() => setLayout(option)}
          >
            {option === 'column_per_day' ? 'A column for each day' : 'A row for each day'}
          </button>
        ))}
      </div>
      <input type="hidden" name="layout" value={layout} />

      {layout === 'column_per_day' ? (
        <div className="row" style={{ padding: 0 }}>
          <div className="field" style={{ minWidth: 290 }}>
            <label htmlFor="headerPattern">What their day headings look like</label>
            <select className="input" id="headerPattern" name="headerPattern" defaultValue={initial.headerPattern}>
              <option value={DAY_THEN_MONTH}>Day then month — &ldquo;1 / 8&rdquo;, &ldquo;1-8 | Sat&rdquo;</option>
              <option value={DAY_ONLY}>Just the day number — &ldquo;1&rdquo;, &ldquo;2&rdquo;, &ldquo;3&rdquo;</option>
              <option value={DAY_THEN_NAME}>Day then month name — &ldquo;01-Sep&rdquo;</option>
            </select>
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="year">Which year</label>
            <input
              className="input"
              type="number"
              id="year"
              name="year"
              min="2000"
              max="2100"
              defaultValue={initial.year}
              placeholder={resolvedYear ? String(resolvedYear) : 'from the file'}
            />
            <p className="hint" style={{ marginTop: 5 }}>
              {initial.year
                ? 'Fixed. Headings like “1 / 8” carry no year, and the wrong one files every absence twelve months out.'
                : resolvedYear
                  ? `Left blank, so it is taken from the file — the last import read ${resolvedYear}. Type a year to fix it instead.`
                  : 'Left blank, so it is taken from the report date inside the file. Type a year to fix it instead.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="dateColumn">Their date column is called</label>
          <input
            className="input"
            id="dateColumn"
            name="dateColumn"
            list="known-columns"
            defaultValue={initial.dateColumn}
            placeholder="Date"
          />
        </div>
      )}

      <div className="field" style={{ maxWidth: 380, marginTop: 12 }}>
        <label htmlFor="separator">Two halves of the day in one cell?</label>
        <select
          className="input"
          id="separator"
          name="separator"
          value={separator}
          onChange={(event) => setSeparator(event.target.value)}
        >
          <option value="">No — one code per day</option>
          <option value="|">Yes, split on | — as in A|P</option>
          <option value="/">Yes, split on / — as in A/P</option>
          <option value="-">Yes, split on - — as in A-P</option>
        </select>
      </div>

      <h3 style={{ fontSize: 15, margin: '26px 0 4px' }}>What their columns are called</h3>
      <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
        Type the heading exactly as it appears in their file. Leave anything they do not send blank — only the first
        three are needed.
      </p>

      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: '38%' }}>We call it</th>
              <th>They call it</th>
            </tr>
          </thead>
          <tbody>
            {PLATFORM_FIELDS.map((field) => (
              <tr key={field}>
                <td>
                  {FIELD_LABELS[field]}
                  {REQUIRED_FIELDS.includes(field) ? (
                    <span className="pill danger" style={{ marginLeft: 6 }}>
                      needed
                    </span>
                  ) : null}
                  {FIELD_NOTES[field] ? <div className="sub">{FIELD_NOTES[field]}</div> : null}
                </td>
                <td>
                  <input
                    className="input"
                    name={`field:${field}`}
                    list="known-columns"
                    defaultValue={initial.fields[field] ?? ''}
                    placeholder="—"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15, margin: '26px 0 4px' }}>What their codes mean</h3>
      <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
        Every code that can appear in their file. Anything not listed is never messaged about, so a code you are unsure
        of is safest left out until you have asked them.
      </p>
      {separator ? (
        <p className="hint" style={{ marginTop: -6, marginBottom: 12 }}>
          <strong>Their cells hold two halves.</strong> A cell reading{' '}
          <code>
            A{separator}P
          </code>{' '}
          is absent in the morning and present in the afternoon, which is how a half day is told from a full one. So
          each half is given a meaning on its own — <code>A</code> and <code>P</code> — and a code that only ever
          appears doubled, like{' '}
          <code>
            HO{separator}HO
          </code>
          , is still mapped as <code>HO</code>. A pair typed here is split for you.
        </p>
      ) : null}

      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Their code</th>
              <th>Means</th>
              <th style={{ width: 80 }}>Chase</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {codes.map((row, index) => (
              <tr key={index}>
                <td>
                  <input
                    className="input"
                    name="codeName"
                    value={row.code}
                    onChange={(event) => setCode(index, { code: event.target.value })}
                    placeholder="A"
                  />
                </td>
                <td>
                  <select
                    className="input"
                    name="codeMeaning"
                    value={row.meaning}
                    onChange={(event) => setCode(index, { meaning: event.target.value as Meaning })}
                  >
                    {ALL_MEANINGS.map((meaning) => (
                      <option key={meaning} value={meaning}>
                        {meaning === 'unknown' ? 'Not recognised — never chase' : meaningLabel(meaning)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {/* A hidden twin, because an unticked checkbox submits nothing
                      and the three code columns have to stay the same length. */}
                  <input type="hidden" name="codeChase" value={row.chase ? 'yes' : 'no'} />
                  <input
                    type="checkbox"
                    checked={row.chase}
                    onChange={(event) => setCode(index, { chase: event.target.checked })}
                    title="Chase this code even when its meaning is not normally chased"
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setCodes((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        className="btn"
        style={{ marginTop: 10 }}
        onClick={() => setCodes((rows) => [...rows, { code: '', meaning: 'absent_full', chase: false }])}
      >
        Add a code
      </button>

      <div className="btn-row" style={{ marginTop: 22 }}>
        <button className="btn primary" type="submit">
          Save mapping
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Saving changes nothing already imported. Import a file afterwards to read it with these rules.
      </p>
    </div>
  );
}
