import 'dotenv/config';

// Tests run against the local Docker Postgres and must never reach a provider.
// NODE_ENV is read-only in the type definitions, so assign through the record.
const environment = process.env as Record<string, string>;
environment.NODE_ENV = 'test';
environment.DRY_RUN = 'true';
// Three call lines, as in production, unless a file says otherwise for itself.
delete environment.CALL_LINES;

// The call lines are shared by the whole platform, so a call one test leaves
// "in progress" would hold a line into the next. Every test starts with all free.
import { beforeEach } from 'vitest';
beforeEach(async () => {
  const { clearCallLines } = await import('@/lib/voice/lines');
  await clearCallLines();
});
