import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Wordmark } from '@/components/wordmark';
import { getActiveTenantId, getSession, isPlatformAdmin } from '@/lib/auth';
import { listTenantsForSwitcher, tenantSummary } from '@/lib/queries';
import { switchTenant, signOutAction } from '@/app/actions';

const NAV = [
  { href: '/', label: 'Dashboard', icon: '▦' },
  { href: '/cases', label: 'Follow-up Cases', icon: '☑' },
  { href: '/mapping', label: 'Mapping & Import', icon: '⇄' },
  { href: '/knowledge', label: 'Guidelines', icon: '◆' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const tenantId = await getActiveTenantId(session);
  const { tenant } = tenantId ? await tenantSummary(tenantId) : { tenant: null };
  const tenants = isPlatformAdmin(session) ? await listTenantsForSwitcher() : [];

  return (
    <div className="shell">
      <aside className="sidebar">
        <Wordmark />
        <div className="caption">Attendance Agent</div>

        <nav className="nav">
          {NAV.map((item) => (
            <Link key={item.href} className="nav-item" href={item.href}>
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
          {isPlatformAdmin(session) ? (
            <Link className="nav-item" href="/admin">
              <span>◉</span>
              <span>All Customers</span>
            </Link>
          ) : null}
        </nav>

        {tenants.length ? (
          <form action={switchTenant} style={{ marginTop: 18 }}>
            <label className="caption" htmlFor="tenantId" style={{ display: 'block', marginBottom: 6 }}>
              Viewing customer
            </label>
            <select className="input" id="tenantId" name="tenantId" defaultValue={tenantId ?? ''}>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className="btn small" type="submit" style={{ marginTop: 8, width: '100%' }}>
              Switch
            </button>
          </form>
        ) : null}

        <div className="sidebar-foot">
          <div className="sidebar-foot-name">{tenant?.name ?? 'No customer'}</div>
          <div className="sidebar-foot-role">
            {session.name} · {session.role.replace(/_/g, ' ')}
          </div>
          <form action={signOutAction}>
            <button className="linkish" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
