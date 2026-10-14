import { redirect } from 'next/navigation';
import { getSession, isPlatformAdmin } from '@/lib/auth';
import { platformOverview } from '@/lib/queries';
import { capabilities } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { budgetStatus } from '@/lib/models/budget';
import { topUpAiBudget } from '@/app/actions';
import { Pill } from '@/components/status-pill';

const BUDGET_LABELS = { whatsapp: 'WhatsApp', call: 'Calls' } as const;
const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!isPlatformAdmin(session)) redirect('/');

  const tenants = await platformOverview();
  const caps = capabilities();
  const budgets = await budgetStatus();

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">Talent Carriage console</div>
        <h1>All customers</h1>
        <p>Health across every customer on the platform, so problems are found before anyone reports them.</p>
      </section>

      <div className="card flush gap-below">
        <div className="table-scroll">
          <table className="data small">
            <thead>
              <tr>
                <th>Customer</th>
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
                      <>
                        <Pill tone="done">Automatic</Pill>
                        <div className="sub">{tenant.checkTime?.slice(0, 5)}</div>
                      </>
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
      </div>

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
