import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/lib/env';

/** Drops everything. Development convenience; refuses to run in production. */
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset a production database');
  const pool = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL });
  await drizzle(pool).execute(sql`drop schema public cascade; create schema public;`);
  console.log('database reset - run npm run db:migrate next');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
