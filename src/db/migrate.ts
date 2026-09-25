import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/lib/env';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Migrations need owner rights; the application itself never has them.
  const pool = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: path.join(here, 'migrations') });
  // RLS policies and triggers live outside Drizzle's generated SQL, and are
  // re-applied every time so a new table cannot be left unprotected.
  await db.execute(sql.raw(fs.readFileSync(path.join(here, 'rls.sql'), 'utf8')));
  console.log('migrations + row-level security applied');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
