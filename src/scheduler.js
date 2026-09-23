import cron from 'node-cron';
import { getSettings, setSetting } from './db.js';
import { runCheck, markNoReply } from './cases.js';

const tz = () => process.env.TZ_NAME || 'Asia/Kolkata';

export function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date()); // YYYY-MM-DD
}

function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

let running = false;

export function startScheduler() {
  // Every minute: if enabled and past check_time, run today's check once.
  cron.schedule('* * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const s = await getSettings();
      const today = todayLocal();
      if (s.scheduler_enabled === 'true' && nowHHMM() >= s.check_time && s.last_auto_run !== today) {
        await setSetting('last_auto_run', today);
        await runCheck(today, { source: 'scheduler' });
      }
    } catch (err) {
      console.error('[scheduler] run failed:', err);
    } finally {
      running = false;
    }
  });

  // Hourly: no answer 48h after sending -> "No reply" (end of the demo flow).
  cron.schedule('5 * * * *', async () => {
    try {
      const n = await markNoReply({ olderThanHours: 48 });
      if (n) console.log(`[scheduler] marked ${n} case(s) as no_reply`);
    } catch (err) {
      console.error('[scheduler] no-reply sweep failed:', err);
    }
  });
}
