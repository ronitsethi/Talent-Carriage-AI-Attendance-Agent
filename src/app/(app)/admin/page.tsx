import { redirect } from 'next/navigation';
import { getSession, isPlatformAdmin } from '@/lib/auth';
import { platformOverview } from '@/lib/queries';
import { capabilities } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { Pill } from '@/components/status-pill';

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!isPlatformAdmin(session)) redirect('/');

  const tenants = await platformOverview();
  const caps = capabilities();

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
