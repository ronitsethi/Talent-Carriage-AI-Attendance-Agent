import { analyseLeaveFile, discardLeaveDraft, saveLeaveMapping } from '@/app/actions';
import { FileDrop } from '@/components/file-drop';
import { Notice } from '@/components/notice';
import { Toast } from '@/components/toast';
import { formatTime } from '@/lib/display';
import { LEAVE_FIELDS } from '@/lib/leave-balance';
import { leaveMappingOverview } from '@/lib/queries';

/**
 * The leave balance mapping, on Mapping beside the attendance and payroll ones:
 * which column of this customer's leave balance file is which. A sample file can
 * fill the form in; nothing is used until it is saved. Leave balance uploads on
 * Uploads are read with the saved mapping.
 */
export async function LeaveBalanceMapping({ tenantId, filled, saved }: { tenantId: string; filled?: string; saved?: string }) {
  const profile = await leaveMappingOverview(tenantId);
  const draft = profile?.draft ?? null;
  const values = draft?.fieldMap ?? profile?.fieldMap ?? {};
  const columns = draft?.columns ?? profile?.columns ?? [];

  return (
    <section className="card pad gap-below" id="leave-mapping">
      {saved ? <Toast clear={['leaveSaved']}>Leave balance mapping saved and in use.</Toast> : null}
      {filled && draft ? (
        <Toast clear={['leaveFilled']}>Filled in from {draft.filename}. Check it and press Save leave balance mapping.</Toast>
      ) : null}

      <div className="section-head">
        <h2>Leave balance mapping</h2>
      </div>
      <p className="card-desc">
        Which column of this customer&apos;s leave balance file is which. The file has one row per employee per leave type.
        Leave balances are uploaded on Uploads and read with this mapping, and the agent answers &ldquo;how many leaves do I
        have left?&rdquo; from them. Which leave each leave type is (PL, CL, SL…) comes from the code table on the Attendance
        tab, the same codes as in the attendance, so the leave name column is not needed.
        {profile?.savedAt ? ` Last saved ${formatTime(profile.savedAt)}.` : ' Not set up yet.'}
      </p>

      {draft ? (
        <Notice tone="info">
          <strong>Filled in from {draft.filename}, not saved yet.</strong> Check each column below and press Save leave
          balance mapping. Nothing is used until then.{' '}
          <form action={discardLeaveDraft} style={{ display: 'inline' }}>
            <button className="btn small" type="submit">
              Discard
            </button>
          </form>
        </Notice>
      ) : null}

      <form action={analyseLeaveFile} className="upload-row gap-below">
        <FileDrop id="leaveSample" name="file" accept=".xlsx,.xls,.csv" hint=".xlsx .xls .csv" label="Fill the form from a leave balance file" required />
        <button className="btn lg" type="submit">
          Fill in leave balance mapping
        </button>
      </form>

      <form action={saveLeaveMapping} key={`${profile?.savedAt?.toISOString() ?? ''}-${draft?.filename ?? ''}`}>
        <datalist id="leave-columns">
          {columns.map((column) => (
            <option key={column} value={column} />
          ))}
        </datalist>
        <div className="payroll-fields">
          {LEAVE_FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`leave_${field.key}`}>
                {field.label}
                {field.required ? <span className="chip err" style={{ marginLeft: 6 }}>needed</span> : ' (if the file has it)'}
              </label>
              <input
                className="input"
                id={`leave_${field.key}`}
                name={`leave_${field.key}`}
                list="leave-columns"
                placeholder="Their column heading"
                defaultValue={values[field.key] ?? ''}
              />
            </div>
          ))}
        </div>
        <button className="btn primary lg" type="submit" style={{ marginTop: 16 }}>
          Save leave balance mapping
        </button>
      </form>
    </section>
  );
}
