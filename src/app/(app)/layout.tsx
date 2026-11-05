import { redirect } from 'next/navigation';
import { Wordmark } from '@/components/wordmark';
import { getActiveTenantId, getSession, isPlatformAdmin } from '@/lib/auth';
import { caseCounts, listTenantsForSwitcher, tenantSummary } from '@/lib/queries';
import { capabilities } from '@/lib/env';
import { models } from '@/lib/models/gateway';
import { automaticUploads } from '@/lib/upload-send';
import { switchTenant, signOutAction } from '@/app/actions';
import { Nav, Shell } from './shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const tenantId = await getActiveTenantId(session);
  const [{ tenant, settings }, counts] = tenantId
    ? await Promise.all([tenantSummary(tenantId), caseCounts(tenantId)])
    : [{ tenant: null, settings: null }, null];
  const tenants = isPlatformAdmin(session) ? await listTenantsForSwitcher() : [];
  const caps = capabilities();
  const providers = models.status().filter((p) => p.available && p.provider !== 'stub');
  const initials = session.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');

  const sidebar = (
    <>
      <div className="sidebar-brand">
        <Wordmark variant="sidebar" />
        <div className="caption">Attendance agent</div>
      </div>

      <Nav openCases={counts?.open ?? 0} showAdmin={isPlatformAdmin(session)} />

      {tenants.length ? (
        // Keyed on the customer: React resets a form after its action, which would put the select back on the
        // option it was first drawn with (the previous customer). A new key draws it again with the new one chosen.
        <form key={tenantId ?? 'none'} action={switchTenant} className="tenant-switch">
          <label className="caption" htmlFor="tenantId">
            Viewing customer
          </label>
          <select className="input" id="tenantId" name="tenantId" defaultValue={tenantId ?? ''}>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn small" type="submit">
            Switch
          </button>
        </form>
      ) : null}

      <div className="sidebar-foot">
        <div className="avatar" aria-hidden>
          {initials}
        </div>
        <div className="sidebar-foot-text">
          <div className="sidebar-foot-name">{tenant?.name ?? 'No customer'}</div>
          <div className="sidebar-foot-role">
            {session.name} · {session.role.replace(/_/g, ' ')}
          </div>
        </div>
        <form action={signOutAction}>
          <button className="linkish" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </>
  );

  // What used to sit under the dashboard's numbers, here so it shows on every page.
  const statusBar = (
    <>
      <span className={`flag ${caps.dryRun ? 'warn' : 'ok'}`}>
        {caps.dryRun ? 'Dry run · nothing is delivered' : 'Live · messages and calls go out'}
      </span>
      {settings ? (
        <>
          <span className={`flag ${settings.sendingEnabled ? 'ok' : 'err'}`}>
            {settings.sendingEnabled ? 'Sending enabled' : 'Sending switched off'}
          </span>
          <span className={`flag ${providers.length ? 'ok' : ''}`}>
            {providers.length ? `AI: ${providers.map((p) => p.provider).join(', ')}` : 'AI: rules only'}
          </span>
          <span className={`flag ${automaticUploads(settings) ? 'ok' : ''}`}>
            {automaticUploads(settings)
              ? 'Automatic · sends after each upload, except rows set to Manual'
              : 'Manual · nothing goes out on its own, whatever the rows say'}
          </span>
          <span className="flag">Calls from {settings.callerId ?? 'no number set'}</span>
        </>
      ) : null}
    </>
  );

  return (
    <Shell sidebar={sidebar} statusBar={statusBar}>
      {children}
    </Shell>
  );
}
