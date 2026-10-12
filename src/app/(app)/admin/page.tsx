import { redirect } from 'next/navigation';
import { getSession, isPlatformAdmin } from '@/lib/auth';
import { platformOverview } from '@/lib/queries';
import { capabilities } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { budgetStatus } from '@/lib/models/budget';
import { topUpAiBudget } from '@/app/actions';

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
        <div className="eyebrow">◉ Talent Carriage console</div>
        <h1>All customers</h1>
        <p>Health across every customer on the platform, so problems are found before anyone reports them.</p>
      </section>

      <div className="card table-scroll" style={{ marginTop: 18 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Employees</th>
              <th>Cases</th>
              <th>Awaiting reply</th>
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
                  <div className="sub">{tenant.slug}</div>
                </td>
                <td>{tenant.employees}</td>
                <td>{tenant.cases}</td>
                <td>{tenant.awaiting}</td>
                <td>{tenant.attention ? <span className="pill call">{tenant.attention}</span> : '0'}</td>
                <td>{tenant.sendingEnabled ? <span className="pill done">On</span> : <span className="pill idle">Off</span>}</td>
                <td className="nowrap">
                  {tenant.operatingMode === 'automatic' ? (
                    <>
                      <span className="pill done">Automatic</span>
                      <div className="sub">{tenant.checkTime?.slice(0, 5)}</div>
                    </>
                  ) : (
                    <span className="pill idle">Manual</span>
                  )}
                </td>
                <td>{tenant.actionsEnabled ? <span className="pill done">On</span> : <span className="pill idle">Off</span>}</td>
                <td>{tenant.cap ? tenant.cap : <span className="sub">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card pad" style={{ marginTop: 18 }}>
        <div className="section-head">
          <h2>AI spending</h2>
          <span className="hint">Azure OpenAI credits these features may use. When one is used up, its replies go to HR until it is topped up.</span>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Budget</th>
              <th>Spent</th>
              <th>Allowed</th>
              <th>Left</th>
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
                    {left === 0 ? <span className="pill call">Used up</span> : null}
                  </td>
                  <td>
                    {dollars(b.spentMicros)}
                    <div style={{ height: 6, width: 120, borderRadius: 3, background: 'var(--border-soft)', marginTop: 6 }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${used * 100}%`,
                          borderRadius: 3,
                          background: left === 0 ? 'var(--danger-text)' : 'var(--accent)',
                        }}
                      />
                    </div>
                  </td>
                  <td>{dollars(b.allowanceMicros)}</td>
                  <td>{dollars(left)}</td>
                  <td>
                    <form action={topUpAiBudget} className="btn-row" style={{ alignItems: 'center' }}>
                      <input type="hidden" name="budget" value={b.budget} />
                      <input
                        className="input"
                        type="number"
                        name="dollars"
                        min="0.01"
                        max="1000"
                        step="0.01"
                        defaultValue="10"
                        aria-label={`Dollars to add to ${BUDGET_LABELS[b.budget]}`}
                        style={{ width: 90 }}
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
      </section>

      <section className="card pad" style={{ marginTop: 18 }}>
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
