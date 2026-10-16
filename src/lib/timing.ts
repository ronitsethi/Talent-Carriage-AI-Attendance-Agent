import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where the time goes inside one request, for the voice agent's latency logs.
 *
 * A call turn waits on the database, the classifier, the guideline search and
 * the answer, one after another, and the caller hears the sum as silence. The
 * slow steps wrap themselves in `timed`; a request that wants the breakdown
 * runs inside `collectTimings`, and everything else pays nothing.
 */

type Marks = Map<string, number> & { started?: number };
const current = new AsyncLocalStorage<Marks>();

/** Adds this step's milliseconds to the request being timed, if there is one. */
export async function timed<T>(label: string, fn: () => PromiseLike<T>): Promise<T> {
  const marks = current.getStore();
  if (!marks) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    marks.set(label, (marks.get(label) ?? 0) + (performance.now() - started));
  }
}

/** Records how far into the request this moment is, the first time it happens. */
export function mark(label: string): void {
  const marks = current.getStore();
  if (marks?.started !== undefined && !marks.has(label)) marks.set(label, performance.now() - marks.started);
}

/** Runs `fn` and returns a Server-Timing header value describing it. */
export async function collectTimings<T>(fn: () => Promise<T>): Promise<{ result: T; header: string }> {
  const marks: Marks = new Map();
  const started = performance.now();
  marks.started = started;
  const result = await current.run(marks, fn);
  marks.set('total', performance.now() - started);
  const header = [...marks].map(([label, ms]) => `${label};dur=${Math.round(ms)}`).join(', ');
  return { result, header };
}
