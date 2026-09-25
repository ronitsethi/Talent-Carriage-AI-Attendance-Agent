import { randomUUID } from 'node:crypto';
import { closeDb } from '@/db';
import { handlers } from './handlers';
import { claim, complete, fail, requeueStalled } from './queue';
import { scheduleDueWork } from './scheduler';

/**
 * The background worker: schedule what is due, then work the queue.
 *
 * Run as many as you like - claiming uses SKIP LOCKED, so two workers never take
 * the same job. In Azure this becomes a Function on a timer; the logic is the
 * same either way.
 */
const workerId = `${process.pid}-${randomUUID().slice(0, 6)}`;
let stopping = false;

export async function tick(): Promise<{ processed: number }> {
  await scheduleDueWork();
  await requeueStalled();

  const jobs = await claim(workerId, 10);
  for (const job of jobs) {
    const handler = handlers[job.kind as keyof typeof handlers];
    if (!handler) {
      await fail(job, `No handler for job kind "${job.kind}"`);
      continue;
    }
    try {
      const result = await handler(job);
      await complete(job.id);
      console.log(`[worker] ${job.kind} ${job.tenantId ?? 'platform'}:`, JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[worker] ${job.kind} failed: ${message}`);
      await fail(job, message);
    }
  }
  return { processed: jobs.length };
}

async function loop(intervalMs: number) {
  console.log(`[worker] ${workerId} started`);
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error('[worker] tick failed:', error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  await closeDb();
  console.log('[worker] stopped');
}

if (process.argv[1]?.endsWith('worker.ts')) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  void loop(Number(process.env.WORKER_INTERVAL_MS ?? 5000));
}
