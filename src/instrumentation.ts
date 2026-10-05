import { env } from '@/lib/env';

/**
 * Runs the background queue inside the web server.
 *
 * The daily check, the day-2 reminders and the retry of stalled jobs are queued
 * by `scheduleDueWork` and worked by `tick`. On a laptop that is `npm run
 * worker` in a second terminal. On a server there is no second terminal, and a
 * deployment where nobody ticks the queue is one where the automatic customers
 * are silently never contacted - which looks exactly like everything working.
 *
 * So the server ticks it itself. That is safe rather than convenient: every job
 * carries a dedupe key and `claim` uses SELECT ... FOR UPDATE SKIP LOCKED, so a
 * second instance - or the standalone worker running alongside - takes different
 * jobs rather than the same ones twice.
 *
 * It needs the process to stay alive between requests, which is what Always On
 * buys on App Service. Without it this would run only while somebody happened to
 * be using the portal.
 */

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 15_000);

export async function register() {
  // instrumentation is loaded on the edge runtime too, where there is no queue
  // and no database driver.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!env.BACKGROUND_WORKER) return;

  const { tick } = await import('@/lib/jobs/worker');

  let running = false;
  const beat = async () => {
    // A slow tick must not overlap the next one: two passes claiming at once is
    // safe, but one pass piling up behind another is not worth finding out.
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (error) {
      console.error('[worker] tick failed:', error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(beat, INTERVAL_MS);
  // Nothing should be kept alive by this alone.
  timer.unref?.();
  console.log(`[worker] queue running in-process every ${INTERVAL_MS}ms`);
}
