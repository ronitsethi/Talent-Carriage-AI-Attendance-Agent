import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db, withPlatformScope, type Db } from '@/db';
import { jobs } from '@/db/schema';

export type JobKind =
  | 'daily_check'
  | 'send_follow_up'
  | 'place_call'
  | 'approval_timeout'
  | 'verify_action'
  | 'import_file'
  | 'refresh_leave_balances';

export type Job = typeof jobs.$inferSelect;

export type EnqueueOptions = {
  tenantId?: string | null;
  runAt?: Date;
  /** Makes a job unique: "one daily check per tenant per date" is a dedupe key. */
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
};

/**
 * A Postgres-backed queue.
 *
 * Deliberately plain: the work is visible in SQL, survives a restart, and is
 * claimed with SKIP LOCKED so several workers never take the same job. The same
 * interface is what an Azure Service Bus implementation will satisfy later.
 */
export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
  tx?: Db,
): Promise<Job | null> {
  const run = async (database: Db) => {
    const inserted = await database
      .insert(jobs)
      .values({
        tenantId: opts.tenantId ?? null,
        kind,
        payload,
        runAt: opts.runAt ?? new Date(),
        dedupeKey: opts.dedupeKey,
        priority: opts.priority ?? 5,
        maxAttempts: opts.maxAttempts ?? 5,
      })
      .onConflictDoNothing({ target: jobs.dedupeKey })
      .returning();
    return inserted[0] ?? null;
  };
  return tx ? run(tx) : withPlatformScope(run);
}

/** Takes up to `limit` jobs that are due, locking them against other workers. */
export async function claim(workerId: string, limit = 5): Promise<Job[]> {
  const { rows } = await db.execute<Job>(sql`
    with due as (
      select id from ${jobs}
      where status = 'pending' and run_at <= now()
      order by priority asc, run_at asc
      limit ${limit}
      for update skip locked
    )
    update ${jobs} j
    set status = 'claimed', claimed_at = now(), claimed_by = ${workerId}, attempts = j.attempts + 1
    from due
    where j.id = due.id
    returning j.*
  `);
  return rows;
}

export async function complete(jobId: string): Promise<void> {
  await withPlatformScope((tx) =>
    tx.update(jobs).set({ status: 'done', finishedAt: new Date(), lastError: null }).where(eq(jobs.id, jobId)),
  );
}

/**
 * Fails a job and schedules a retry with a widening gap, so a provider having a
 * bad minute is not hammered. After the last attempt it becomes `dead` and stays
 * visible for a human rather than disappearing.
 */
export async function fail(job: Job, error: string): Promise<void> {
  const exhausted = job.attempts >= job.maxAttempts;
  const backoffMinutes = Math.min(60, 2 ** job.attempts);
  await withPlatformScope((tx) =>
    tx
      .update(jobs)
      .set({
        status: exhausted ? 'dead' : 'pending',
        lastError: error,
        runAt: exhausted ? job.runAt : new Date(Date.now() + backoffMinutes * 60_000),
        finishedAt: exhausted ? new Date() : null,
      })
      .where(eq(jobs.id, job.id)),
  );
}

/** Jobs a human should look at: exhausted retries, and anything stuck claimed. */
export async function stalled(olderThanMinutes = 15) {
  return withPlatformScope((tx) =>
    tx
      .select()
      .from(jobs)
      .where(
        or(
          eq(jobs.status, 'dead'),
          and(
            eq(jobs.status, 'claimed'),
            lte(jobs.claimedAt, new Date(Date.now() - olderThanMinutes * 60_000)),
          ),
        ),
      )
      .orderBy(asc(jobs.runAt)),
  );
}

/** Returns a stuck job to the queue - a worker that died mid-job leaves these. */
export async function requeueStalled(olderThanMinutes = 15): Promise<number> {
  const result = await withPlatformScope((tx) =>
    tx
      .update(jobs)
      .set({ status: 'pending', claimedAt: null, claimedBy: null })
      .where(
        and(eq(jobs.status, 'claimed'), lte(jobs.claimedAt, new Date(Date.now() - olderThanMinutes * 60_000))),
      )
      .returning(),
  );
  return result.length;
}
