import { and, eq, inArray, like } from 'drizzle-orm';
import type { Db } from '@/db';
import { jobs } from '@/db/schema';
import { enqueue } from '@/lib/jobs/queue';

/**
 * A call that found every line busy, waiting for one.
 *
 * It is a `waiting_call` job, tried again every 15 seconds until a line is free.
 * The queue takes jobs by priority, so whatever waits goes in this order:
 * follow-ups (and final notices), then managers' approval calls, then first
 * questions - and, within each, whoever has waited longest.
 */
export type WaitingCall =
  | { action: 'contact_case'; caseId: string; followUp?: boolean }
  | { action: 'follow_ups'; employeeId: string; mode: 'due' | 'upload' }
  | { action: 'approval'; approvalId: string };

const priorityOf = (call: WaitingCall) =>
  call.action === 'follow_ups' || (call.action === 'contact_case' && call.followUp) ? 2 : call.action === 'approval' ? 3 : 4;

const refOf = (call: WaitingCall) =>
  call.action === 'contact_case' ? `case:${call.caseId}` : call.action === 'follow_ups' ? `follow_ups:${call.employeeId}` : `approval:${call.approvalId}`;

/** Queues the call to wait for a line. One wait per call: asking twice adds nothing. */
export async function waitForLine(tx: Db, tenantId: string, call: WaitingCall): Promise<void> {
  const ref = refOf(call);
  const [already] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, 'waiting_call'), inArray(jobs.status, ['pending', 'claimed']), like(jobs.dedupeKey, `waiting:${ref}:%`)))
    .limit(1);
  if (already) return;
  await enqueue('waiting_call', call, { tenantId, priority: priorityOf(call), dedupeKey: `waiting:${ref}:${Date.now()}` }, tx);
}

/** What a sender reports when it could not ring because every line was busy. */
export const WAITING_FOR_LINE = 'Waiting for a free call line';
