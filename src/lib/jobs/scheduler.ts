import { eq } from 'drizzle-orm';
import { withPlatformScope } from '@/db';
import { tenants, tenantSettings } from '@/db/schema';
import { enqueue } from './queue';

/**
 * Decides what should be queued right now.
 *
 * Housekeeping and the manager's and HR's steps run on the clock. Everything that
 * contacts an employee - first questions, reminders and follow-ups - starts from
 * HR or from an attendance upload (`upload-send.ts`); a day with no upload sends
 * them nothing.
 * Every job carries a dedupe key, so running this every minute - or twice at once
 * on two workers - still produces one sweep per tenant per hour.
 */
export async function scheduleDueWork(at = new Date()) {
  const rows = await withPlatformScope((tx) =>
    tx
      .select({ tenantId: tenants.id, status: tenants.status, timezone: tenantSettings.timezone })
      .from(tenants)
      .innerJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id)),
  );

  const queued: string[] = [];

  for (const tenant of rows) {
    if (tenant.status !== 'active') continue;

    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tenant.timezone }).format(at);
    const localHour = new Intl.DateTimeFormat('en-GB', { timeZone: tenant.timezone, hour: '2-digit', hour12: false }).format(at);

    const hourKey = `${localDate}:${localHour}`;
    for (const kind of ['approval_timeout', 'verify_action'] as const) {
      const job = await enqueue(kind, {}, { tenantId: tenant.tenantId, dedupeKey: `${kind}:${tenant.tenantId}:${hourKey}` });
      if (job) queued.push(`${kind} ${tenant.tenantId}`);
    }
    // HR's daily summary, from ten in the morning; the job itself skips non-working days.
    if (Number(localHour) >= 10) {
      const job = await enqueue('hr_summary', {}, { tenantId: tenant.tenantId, dedupeKey: `hr_summary:${tenant.tenantId}:${localDate}` });
      if (job) queued.push(`hr_summary ${tenant.tenantId}`);
    }
  }

  return { queued };
}
