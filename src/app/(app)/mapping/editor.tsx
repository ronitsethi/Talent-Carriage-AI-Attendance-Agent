'use client';

import { useState } from 'react';
import type { Analysis } from '@/lib/mapping/analyse';
import { PLATFORM_FIELDS, REQUIRED_FIELDS, type PlatformField } from '@/lib/mapping/apply';
import { ALL_MEANINGS } from '@/lib/mapping/meanings';
import { meaningLabel } from '@/lib/display';

/**
 * The screen where somebody teaches the platform to read one customer's file.
 *
 * Everything here starts as a guess made from the file itself, and every guess
 * is editable. That is the point: a column matched by its heading is a
 * coincidence until a person confirms it, and a code guessed from its letter is
 * how you end up telephoning people who were never absent.
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

export function MappingEditor({ analysis, profileId }: { analysis: Analysis; profileId: string }) {
  const [layout, setLayout] = useState(analysis.layout);
  const ordinary = analysis.columns.filter((c) => !c.looksLikeDay);

  return (
    <div className="card pad">
      <div className="section-head">
        <h2>Match their file to ours</h2>
        <span className="hint">
          {analysis.sheetName} · {analysis.rowCount} rows · {analysis.columns.length} columns
        </span>
      </div>

      <p className="hint" style={{ marginTop: 0, marginBottom: 16 }}>
        Everything below was guessed from the file. Check each one — especially the codes, which decide who gets
        telephoned.
      </p>

      <input type="hidden" name="profileId" value={profileId} />
      <input type="hidden" name="sheetName" value={analysis.sheetName} />

      <div className="row" style={{ padding: 0, marginBottom: 18 }}>
        <div className="field" style={{ minWidth: 240 }}>
          <label htmlFor="name">Name this mapping</label>
          <input className="input" id="name" name="name" defaultValue={`${analysis.sheetName} export`} />
        </div>
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="hrmsHint">Which HRMS (optional)</label>
          <input className="input" id="hrmsHint" name="hrmsHint" placeholder="e.g. TimeOffice, greytHR" />
        </div>
      </div>

      {/* ---------- how the dates are laid out ---------- */}
      <h3 style={{ fontSize: 15, margin: '18px 0 8px' }}>How the dates are laid out</h3>
      <div className="switch-group" style={{ marginBottom: 12 }}>
        {(['column_per_day', 'row_per_day'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`switch-option ${layout === option ? 'on' : ''}`}
            onClick={() => setLayout(option)}
          >
            {option === 'column_per_day' ? 'One column per day' : 'One row per day'}
          </button>
        ))}
      </div>
      <input type="hidden" name="layout" value={layout} />

      {layout === 'column_per_day' ? (
        <p className="hint">
          Found {analysis.dayColumns.length} day columns
          {analysis.dayColumns.length ? `: ${analysis.dayColumns.slice(0, 4).join(', ')}…` : ''}
          {analysis.year ? ` The year ${analysis.year} was read from the file.` : ''}
        </p>
      ) : (
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="dateColumn">Which column holds the date</label>
          <select className="input" id="dateColumn" name="dateColumn" defaultValue={guessDateColumn(ordinary)}>
            {ordinary.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="field" style={{ maxWidth: 320, marginTop: 12 }}>
        <label htmlFor="separator">Two halves in one cell?</label>
        <select className="input" id="separator" name="separator" defaultValue={analysis.separator ?? ''}>
          <option value="">No — one code per day</option>
          <option value="|">Yes, split on | (as in A|P)</option>
          <option value="/">Yes, split on / (as in A/P)</option>
          <option value="-">Yes, split on - (as in A-P)</option>
        </select>
      </div>
      <input type="hidden" name="year" value={analysis.year ?? ''} />

      {/* ---------- which column is which ---------- */}
      <h3 style={{ fontSize: 15, margin: '26px 0 4px' }}>Which of their columns is which</h3>
      <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
        Only the first three are needed. The rest improve the portal but nothing depends on them.
      </p>

      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: '32%' }}>We call it</th>
              <th style={{ width: '34%' }}>Their column</th>
              <th>What that column contains</th>
            </tr>
          </thead>
          <tbody>
            {PLATFORM_FIELDS.map((field) => (
              <FieldRow key={field} field={field} columns={ordinary} chosen={analysis.fields[field] ?? []} />
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------- what their codes mean ---------- */}
      <h3 style={{ fontSize: 15, margin: '26px 0 4px' }}>What their codes mean</h3>
      <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
        Every code in the file, most common first. Anything left as <strong>Not recognised</strong> is never messaged
        about — which is the safe answer when you are not sure.
      </p>

      {analysis.codes.length ? (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Their code</th>
                <th style={{ width: 90 }}>Times seen</th>
                <th>Means</th>
              </tr>
            </thead>
            <tbody>
              {analysis.codes.map((code) => (
                <tr key={code.code}>
                  <td>
                    <code>{code.code}</code>
                  </td>
                  <td className="nowrap">{code.count.toLocaleString('en-IN')}</td>
                  <td>
                    <select
                      className="input"
                      name={`code:${code.code}`}
                      defaultValue={code.guess}
                      style={{ maxWidth: 320 }}
                    >
                      {ALL_MEANINGS.map((meaning) => (
                        <option key={meaning} value={meaning}>
                          {meaning === 'unknown' ? 'Not recognised — never chase' : meaningLabel(meaning)}
                        </option>
                      ))}
                    </select>
                    {!code.confident ? (
                      <div className="sub" style={{ marginTop: 4 }}>
                        Guessed. Worth checking with their HR.
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">
          No codes found. If this is a one-row-per-day file, set the attendance status column above and upload again.
        </p>
      )}

      <button className="btn primary" type="submit" style={{ marginTop: 20 }}>
        Save and use this mapping
      </button>
      <p className="hint" style={{ marginTop: 8 }}>
        Saving does not import anything. Upload the file again on the right once this is right.
      </p>
    </div>
  );
}

function FieldRow({
  field,
  columns,
  chosen,
}: {
  field: PlatformField;
  columns: Analysis['columns'];
  chosen: string[];
}) {
  const [value, setValue] = useState(chosen[0] ?? '');
  const required = REQUIRED_FIELDS.includes(field);
  const preview = columns.find((c) => c.name === value)?.samples ?? [];

  return (
    <tr>
      <td>
        {FIELD_LABELS[field]}
        {required ? <span className="pill danger" style={{ marginLeft: 6 }}>needed</span> : null}
      </td>
      <td>
        <select
          className="input"
          name={`field:${field}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">— not in this file —</option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        {/* A name split across two columns keeps both; the second is hidden here
            but still submitted, so "First Name" + "Last Name" survives a save. */}
        {chosen.slice(1).map((extra) => (
          <input key={extra} type="hidden" name={`field:${field}`} value={extra} />
        ))}
      </td>
      <td className="sub">{preview.length ? preview.join(' · ') : '—'}</td>
    </tr>
  );
}

function guessDateColumn(columns: Analysis['columns']): string {
  return columns.find((c) => /date|day/i.test(c.name))?.name ?? columns[0]?.name ?? '';
}
