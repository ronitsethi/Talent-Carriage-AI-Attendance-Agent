import 'dotenv/config';

// Tests run against the local Docker Postgres and must never reach a provider.
// NODE_ENV is read-only in the type definitions, so assign through the record.
const environment = process.env as Record<string, string>;
environment.NODE_ENV = 'test';
environment.DRY_RUN = 'true';
