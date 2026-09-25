import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { env } from '@/lib/env';
import * as schema from './schema';

// Keep DATE columns as 'YYYY-MM-DD' strings: attendance dates are calendar days,
// not instants, and converting them to JS Dates invites timezone bugs.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'production' ? 20 : 5,
  application_name: 'tc-attendance',
});

export const db = drizzle(pool, { schema });
export type Db = NodePgDatabase<typeof schema>;
export { schema };

/**
 * Run work scoped to one tenant.
 *
 * Row-level security policies compare every row's tenant_id against
 * `app.tenant_id`, so a query inside here physically cannot read or write
 * another customer's rows — the isolation is in the database, not in our WHERE
 * clauses. Everything that serves a customer request must go through this.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Cross-tenant access, for the Talent Carriage console, background workers and
 * migrations. Every use is a deliberate choice and should be audited; prefer
 * withTenant wherever a single customer is being served.
 */
export async function withPlatformScope<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as unknown as Db);
  });
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
