import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, isPlatformAdmin } from '@/lib/auth';
import { platformOverview } from '@/lib/queries';
import { capabilities } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { budgetStatus } from '@/lib/models/budget';
import { addCustomer, deactivateCustomer, reactivateCustomer, removeCustomer, topUpAiBudget } from '@/app/actions';
import { ConfirmSubmit } from '@/components/confirm';
import { Notice } from '@/components/notice';
import { Pill } from '@/components/status-pill';

const BUDGET_LABELS = { whatsapp: 'WhatsApp', call: 'Calls' } as const;
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string; added?: string; changed?: string; problem?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!isPlatformAdmin(session)) redirect('/');

  const { add, added, changed, problem } = await searchParams;
  const tenants = await platformOverview();
  const caps = capabilities();
  const budgets = await budgetStatus();

  return (
    <>
      {added ? (
        <Notice tone="ok" clear={['added']}>
          {added} is added. Choose it under Viewing customer in the sidebar to upload its attendance.
        </Notice>
      ) : null}
      {changed ? (
        <Notice tone="ok" clear={['changed']}>
          {changed}
        </Notice>
      ) : null}
      {problem ? (
        <Notice tone="err" clear={['problem']}>
          {problem}
        </Notice>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">Talent Carriage console</div>
        <h1>All customers</h1>
        <p>Health across every customer on the platform, so problems are found before anyone reports them.</p>
      </section>

      <section className="card flush gap-below">
        <div className="card-head">
          <h2>Customers ({tenants.length})</h2>
          {add ? null : (
            <Link className="btn small primary" href="/admin?add=1">
              Add customer
            </Link>
          )}
        </div>
        {add ? (
          <form action={addCustomer} className="form-section">
            <div className="field" style={{ maxWidth: 420 }}>
              <label htmlFor="customerName">Customer name</label>
              <input className="input" id="customerName" name="name" required maxLength={120} autoFocus />
            </div>
            <p className="field-help">
              It starts in manual mode with sending off, so nothing goes out until that is changed in its Settings. It uses the
              platform&apos;s WhatsApp and phone numbers.
            </p>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button className="btn small primary" type="submit">
                Create customer
              </button>
              <Link className="btn small" href="/admin">
                Cancel
              </Link>
            </div>
          </form>
        ) : null}
        <div className="table-scroll">
          <table className="data small">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Status</th>
                <th className="num">Employees</th>
                <th className="num">Cases</th>
                <th className="num">Awaiting reply</th>
                <th>Needs HR</th>
                <th>Sending</th>
                <th>Mode</th>
                <th>Actions</th>
                <th>Cap</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td>
                    <div className="employee">{tenant.name}</div>
                    <div className="sub mono">{tenant.slug}</div>
                    <div className="btn-row" style={{ flexWrap: 'nowrap', marginTop: 8 }}>
                      <form action={tenant.status === 'suspended' ? reactivateCustomer : deactivateCustomer}>
                        <input type="hidden" name="customerId" value={tenant.id} />
                        {tenant.status === 'suspended' ? (
                          <ConfirmSubmit
                            label="Reactivate"
                            className="btn small"
                            title={`Reactivate ${tenant.name}?`}
                            message="Calls, messages and sign-ins work again. Anything that was waiting to send when it was deactivated stays cancelled."
                            confirmLabel="Reactivate"
                          />
                        ) : (
                          <ConfirmSubmit
                            label="Deactivate"
                            className="btn small"
                            title={`Deactivate ${tenant.name}?`}
                            message="No calls or messages go out, replies are not answered, and its own users cannot sign in. Sends waiting after an upload are cancelled. All its data stays, and you can reactivate it."
                            confirmLabel="Deactivate"
                            tone="danger"
                          />
                        )}
                      </form>
                      <form action={removeCustomer}>
                        <input type="hidden" name="customerId" value={tenant.id} />
                        <ConfirmSubmit
                          label="Delete"
                          className="btn small"
                          title={`Delete ${tenant.name} for good?`}
                          message={`This permanently removes its ${tenant.employees} employees, ${tenant.cases} cases, attendance, conversations, recordings and settings. It cannot be undone.`}
                          confirmLabel="Delete for good"
                          tone="danger"
                          disabled={tenant.status !== 'suspended'}
                        />
                      </form>
                    </div>
                  </td>
                  <td>
                    <Pill tone={tenant.status === 'suspended' ? 'idle' : 'done'}>{tenant.status === 'suspended' ? 'Deactivated' : 'Active'}</Pill>
                  </td>
                  <td className="num">{tenant.employees}</td>
                  <td className="num">{tenant.cases}</td>
                  <td className="num">{tenant.awaiting}</td>
                  <td>
                    <Pill tone={tenant.attention ? 'call' : 'idle'}>{tenant.attention}</Pill>
                  </td>
                  <td>
                    <Pill tone={tenant.sendingEnabled ? 'done' : 'idle'}>{tenant.sendingEnabled ? 'On' : 'Off'}</Pill>
                  </td>
                  <td className="nowrap">
                    {tenant.operatingMode === 'automatic' ? (
                      <Pill tone="done">Automatic</Pill>
                    ) : (
                      <Pill tone="idle">Manual</Pill>
                    )}
                  </td>
                  <td>
                    <Pill tone={tenant.actionsEnabled ? 'done' : 'idle'}>{tenant.actionsEnabled ? 'On' : 'Off'}</Pill>
                  </td>
                  <td>{tenant.cap ? tenant.cap : <span className="sub">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flush gap-below">
        <div className="card-head">
          <h2>AI spending</h2>
          <span className="hint">
            Azure OpenAI credits these features may use. When one is used up, its replies go to HR until it is topped up.
          </span>
        </div>
        <div className="table-scroll">
          <table className="data small">
            <thead>
              <tr>
                <th>Budget</th>
                <th className="num">Spent</th>
                <th className="num">Allowed</th>
                <th className="num">Left</th>
                <th>Top up</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((b) => {
                const left = Math.max(0, b.allowanceMicros - b.spentMicros);
                const used = b.allowanceMicros ? Math.min(1, b.spentMicros / b.allowanceMicros) : 1;
                return (
                  <tr key={b.budget}>
                    <td>
                      <div className="employee">{BUDGET_LABELS[b.budget]}</div>
                      {left === 0 ? (
                        <div style={{ marginTop: 4 }}>
                          <Pill tone="call">Used up</Pill>
                        </div>
                      ) : null}
                    </td>
                    <td className="num mono">
                      {dollars(b.spentMicros)}
                      <div
                        className={`meter${left === 0 ? ' full' : ''}`}
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(used * 100)}
                        aria-label={`${BUDGET_LABELS[b.budget]} budget used`}
                      >
                        <span style={{ width: `${used * 100}%` }} />
                      </div>
                    </td>
                    <td className="num mono">{dollars(b.allowanceMicros)}</td>
                    <td className="num mono">{dollars(left)}</td>
                    <td>
                      <form action={topUpAiBudget} className="btn-row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                        <input type="hidden" name="budget" value={b.budget} />
                        <input
                          className="input sm mono"
                          type="number"
                          name="dollars"
                          min="0.01"
                          max="1000"
                          step="0.01"
                          defaultValue="10"
                          aria-label={`Dollars to add to ${BUDGET_LABELS[b.budget]}`}
                          style={{ width: 96 }}
                        />
                        <button className="btn small primary" type="submit">
                          Top up
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card pad" style={{ maxWidth: 640 }}>
        <div className="section-head">
          <h2>Platform connections</h2>
          <span className="hint">What is wired up right now</span>
        </div>
        <dl className="kv">
          <dt>Delivery</dt>
          <dd>{caps.dryRun ? 'Dry run — nothing reaches a real person' : 'Live'}</dd>
          <dt>WhatsApp</dt>
          <dd>{caps.whatsapp ? 'Meta Cloud API configured' : 'Simulator only'}</dd>
          <dt>Webhook signature</dt>
          <dd>{caps.whatsappSignature ? 'Checked' : 'Not configured'}</dd>
          <dt>Models available</dt>
          <dd>{models.status().filter((m) => m.available).map((m) => m.provider).join(', ')}</dd>
          <dt>HRMS</dt>
          <dd>{caps.hrms}</dd>
          <dt>Voice</dt>
          <dd>{caps.voice}</dd>
        </dl>
      </section>
    </>
  );
}
