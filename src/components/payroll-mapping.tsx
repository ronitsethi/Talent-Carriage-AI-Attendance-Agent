import { analysePayrollFile, discardPayrollDraft, savePayrollMapping } from '@/app/actions';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import { Toast } from '@/components/toast';
import { formatTime } from '@/lib/display';
import { PAYROLL_FIELDS, isSensitive } from '@/lib/payroll';
import { payrollMappingOverview } from '@/lib/queries';

/**
 * The payroll mapping, on Mapping beside the attendance and leave balance ones: which
 * column of this customer's payroll file is which, and which columns the agent
 * may read. A sample file can fill the form in; nothing is used until it is
 * saved. Payroll uploads on Month end are read with the saved mapping.
 */
export async function PayrollMapping({
  tenantId,
  admin,
  filled,
  saved,
}: {
  tenantId: string;
  admin: boolean;
  filled?: string;
  saved?: string;
}) {
  const profile = await payrollMappingOverview(tenantId);
  const draft = profile?.draft ?? null;
  const values = draft?.fieldMap ?? profile?.fieldMap ?? {};
  const columns = draft?.columns ?? profile?.columns ?? [];
  const excluded = draft?.excluded ?? profile?.excluded ?? [];
  const mapped = new Set(Object.values(values).filter(Boolean).map((heading) => String(heading).toLowerCase()));
  // The key columns are always kept; the tick boxes are for everything else.
  const others = columns.filter((column) => !mapped.has(column.toLowerCase()));

  return (
    <section className="card pad gap-below" id="payroll-mapping">
      {saved ? <Toast clear={['payrollSaved']}>Payroll mapping saved and in use.</Toast> : null}
      {filled && draft ? (
        <Toast clear={['payrollFilled']}>Filled in from {draft.filename}. Check it and press Save payroll mapping.</Toast>
      ) : null}

      <div className="section-head">
        <h2>Payroll mapping</h2>
      </div>
      <p className="card-desc">
        Which column of this customer&apos;s payroll file is which, as with attendance. Payroll is uploaded on Month end once
        a month&apos;s attendance is locked, and read with this mapping. PAN, Aadhaar and bank details are never kept, whatever
        is ticked.
        {profile?.savedAt ? ` Last saved ${formatTime(profile.savedAt)}.` : ' Not set up yet.'}
      </p>

      {admin && draft ? (
        <Notice tone="info">
          <strong>Filled in from {draft.filename}, not saved yet.</strong> Check each column below and press Save payroll
          mapping. Nothing is used until then.{' '}
          <form action={discardPayrollDraft} style={{ display: 'inline' }}>
            <button className="btn small" type="submit">
              Discard
            </button>
          </form>
        </Notice>
      ) : null}

      {admin ? (
        <>
          <form action={analysePayrollFile} className="upload-row gap-below">
            <FileDrop id="payrollSample" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Fill the form from a payroll file" required />
            <button className="btn lg" type="submit">
              Fill in payroll mapping
            </button>
          </form>

          <form action={savePayrollMapping} key={`${profile?.savedAt?.toISOString() ?? ''}-${draft?.filename ?? ''}`}>
            <datalist id="payroll-columns">
              {columns.map((column) => (
                <option key={column} value={column} />
              ))}
            </datalist>
            <div className="payroll-fields">
              {PAYROLL_FIELDS.map((field) => (
                <div className="field" key={field.key}>
                  <label htmlFor={`field_${field.key}`}>
                    {field.label}
                    {field.required ? <span className="chip err" style={{ marginLeft: 6 }}>needed</span> : ' (if the file has it)'}
                  </label>
                  <input
                    className="input"
                    id={`field_${field.key}`}
                    name={`field_${field.key}`}
                    list="payroll-columns"
                    placeholder="Their column heading"
                    defaultValue={values[field.key] ?? ''}
                  />
                </div>
              ))}
            </div>

            <h4 className="payroll-subhead">Other columns the agent may read</h4>
            {others.length ? (
              <div className="payroll-keep">
                {others.map((column) => {
                  const sensitive = isSensitive(column);
                  return (
                    <label key={column} className={`month-pick ${sensitive ? 'muted' : ''}`} title={sensitive ? 'Never kept' : undefined}>
                      <input type="checkbox" name="keep" value={column} defaultChecked={!sensitive && !excluded.includes(column)} disabled={sensitive} />
                      {column}
                      {sensitive ? <span className="sub"> · never kept</span> : null}
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="field gap-below">
                <label htmlFor="excludedList">Columns not to keep, one per line (everything else is kept)</label>
                <textarea className="input" id="excludedList" name="excludedList" rows={4} defaultValue={excluded.join('\n')} />
              </div>
            )}
            <button className="btn primary lg" type="submit">
              Save payroll mapping
            </button>
          </form>
        </>
      ) : profile?.fieldMap ? (
        <dl className="kv">
          {PAYROLL_FIELDS.map((field) => (
            <div key={field.key} style={{ display: 'contents' }}>
              <dt>{field.label}</dt>
              <dd>{profile.fieldMap?.[field.key] ?? '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="hint">Only an admin can set up the payroll mapping.</p>
      )}
    </section>
  );
}
