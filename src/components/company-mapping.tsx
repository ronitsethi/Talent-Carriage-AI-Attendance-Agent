import { withTenant } from '@/db';
import { saveCompanyMapping } from '@/app/actions';
import { Toast } from '@/components/toast';
import { companyMapping } from '@/lib/company';

/**
 * The company mapping, on Mapping beside the attendance, leave balance and
 * payroll ones: which column of this customer's files names the company, and
 * the company name itself. Every attendance, leave balance and payroll upload is
 * checked against it.
 */
export async function CompanyMapping({ tenantId, admin, saved }: { tenantId: string; admin: boolean; saved?: string }) {
  const mapping = await withTenant(tenantId, (tx) => companyMapping(tx, tenantId));

  return (
    <section className="card pad gap-below" id="company-mapping">
      {saved ? <Toast clear={['companySaved']}>{mapping ? 'Company mapping saved and in use.' : 'Company mapping cleared. Uploads are no longer checked.'}</Toast> : null}

      <div className="section-head">
        <h2>Company mapping</h2>
      </div>
      <p className="card-desc">
        Which column of this customer&apos;s files names the company, and the company name as it appears there. Every
        attendance, leave balance and payroll upload is checked against it: a file naming any other company in that column
        is refused. Case, spacing, punctuation and words like Private Limited, Pvt Ltd or LLP are ignored. A file without
        that column, or blank cells in it, are not checked.{' '}
        {mapping ? `In use: ${mapping.column} must be ${mapping.name}.` : 'Not set up yet, so uploads are not checked.'}
      </p>

      {admin ? (
        <form action={saveCompanyMapping}>
          <div className="payroll-fields">
            <div className="field">
              <label htmlFor="companyColumn">Company name column</label>
              <input
                className="input"
                id="companyColumn"
                name="companyColumn"
                placeholder="e.g. Company"
                defaultValue={mapping?.column ?? ''}
              />
            </div>
            <div className="field">
              <label htmlFor="companyName">Company name</label>
              <input
                className="input"
                id="companyName"
                name="companyName"
                placeholder="e.g. Acme Widgets Pvt Ltd"
                defaultValue={mapping?.name ?? ''}
              />
            </div>
          </div>
          <button className="btn primary lg" type="submit" style={{ marginTop: 16 }}>
            Save company mapping
          </button>
        </form>
      ) : (
        <p className="hint">Only an admin can set up the company mapping.</p>
      )}
    </section>
  );
}
