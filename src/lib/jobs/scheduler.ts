import { eq } from 'drizzle-orm';
import { withPlatformScope } from '@/db';
import { tenants, tenantSettings } from '@/db/schema';
import { enqueue } from './queue';

/**
 * Decides what should be queued right now.
 *
 * Every job carries a dedupe key, so running this every minute - or twice at
 * once on two workers - still produces exactly one daily check per tenant per
 * day. A missed run simply catches up on the next pass instead of skipping.
 */
export async function scheduleDueWork(at = new Date()) {
  const rows = await withPlatformScope((tx) =>
    tx
      .select({
        tenantId: tenants.id,
        status: tenants.status,
        timezone: tenantSettings.timezone,
        checkTime: tenantSettings.checkTime,
        operatingMode: tenantSettings.operatingMode,
      })
      .from(tenants)
      .innerJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id)),
  );

  const queued: string[] = [];

  for (const tenant of rows) {
    if (tenant.status !== 'active') continue;
    // Manual customers are driven entirely from the portal; the scheduler leaves
    // them alone, including their reminders.
    if (tenant.operatingMode !== 'automatic') continue;

    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(at);
    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: tenant.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);

    if (localTime >= tenant.checkTime.slice(0, 5)) {
      const job = await enqueue(
        'daily_check',
        { date: localDate, trigger: 'schedule' },
        { tenantId: tenant.tenantId, dedupeKey: `daily_check:${tenant.tenantId}:${localDate}` },
      );
      if (job) queued.push(`daily_check ${tenant.tenantId} ${localDate}`);
    }

    // Reminders, approval timeouts and verification are swept hourly.
    const hourKey = `${localDate}:${localTime.slice(0, 2)}`;
    for (const kind of ['send_follow_up', 'approval_timeout', 'verify_action'] as const) {
      const job = await enqueue(kind, {}, { tenantId: tenant.tenantId, dedupeKey: `${kind}:${tenant.tenantId}:${hourKey}` });
      if (job) queued.push(`${kind} ${tenant.tenantId}`);
    }
  }

  return { queued };
}
