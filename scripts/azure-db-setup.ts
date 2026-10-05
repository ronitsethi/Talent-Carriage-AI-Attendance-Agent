import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Prepares this platform's database on the PostgreSQL server Client Hub already
 * uses.
 *
 * The server is shared; the database is not. This creates a database of its own,
 * turns on pgvector inside it, and creates the unprivileged role the application
 * connects as - the same `tc_app` that row-level security is written against
 * locally, so nothing about the application changes between a laptop and Azure.
 *
 * It touches nothing belonging to Client Hub. It is safe to run twice.
 *
 *   npx tsx scripts/azure-db-setup.ts \
 *     --host tc-clienthub-pg-99772.postgres.database.azure.com \
 *     --admin <admin user> --password <admin password>
 */

const args = new Map<string, string>();
const argv = process.argv.slice(2).filter((a) => a !== '--reset-password');
for (let i = 0; i < argv.length; i += 2) {
  args.set(argv[i]!.replace(/^--/, ''), argv[i + 1] ?? '');
}

const host = args.get('host') ?? 'tc-clienthub-pg-99772.postgres.database.azure.com';
const adminArg = args.get('admin');
const passwordArg = args.get('password') ?? process.env.PGADMINPASSWORD;
const dbName = args.get('database') ?? 'attendance';
const appRole = args.get('role') ?? 'tc_app';

if (!adminArg || !passwordArg) {
  console.error('need --admin and --password (or PGADMINPASSWORD)');
  process.exit(1);
}
const admin: string = adminArg;
const password: string = passwordArg;

/** Readable, no quoting surprises in a connection string. */
const appPassword = args.get('app-password') ?? randomBytes(24).toString('base64url');

/**
 * Rotating the application's password breaks whatever is already running on it
 * until App Settings catch up, so it is never done by accident.
 */
const resetPassword = process.argv.includes('--reset-password');

function connect(database: string) {
  return new pg.Client({
    host,
    port: 5432,
    user: admin,
    password,
    database,
    ssl: { rejectUnauthorized: true },
  });
}

async function main() {
  const server = connect('postgres');
  await server.connect();

  const existing = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (existing.rowCount) {
    console.log(`database ${dbName} already exists`);
  } else {
    // No parameters: CREATE DATABASE cannot take them.
    await server.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
    console.log(`created database ${dbName}`);
  }

  const role = await server.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole]);
  if (role.rowCount && !resetPassword) {
    console.log(
      `role ${appRole} already exists - leaving its password alone, so the connection string below is NOT usable.\n` +
        'Re-run with --reset-password to set a new one.',
    );
  } else if (role.rowCount) {
    await server.query(
      `ALTER ROLE ${pg.escapeIdentifier(appRole)} PASSWORD ${pg.escapeLiteral(appPassword)}`,
    );
    console.log(`reset the password on ${appRole}`);
  } else {
    await server.query(
      `CREATE ROLE ${pg.escapeIdentifier(appRole)} LOGIN PASSWORD ${pg.escapeLiteral(appPassword)}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    console.log(`created role ${appRole}`);
  }

  // The role has no business in any other database on this server.
  await server.query(
    `REVOKE ALL ON DATABASE ${pg.escapeIdentifier(dbName)} FROM PUBLIC`,
  );
  await server.query(
    `GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(dbName)} TO ${pg.escapeIdentifier(appRole)}`,
  );
  await server.end();

  const db = connect(dbName);
  await db.connect();
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  console.log('pgvector enabled');
  await db.end();

  const enc = encodeURIComponent;
  console.log('\nSet these as App Settings:');
  console.log(`DATABASE_URL=postgresql://${enc(appRole)}:${enc(appPassword)}@${host}:5432/${dbName}?sslmode=require`);
  console.log(`MIGRATION_DATABASE_URL=postgresql://${enc(admin)}:${enc(password)}@${host}:5432/${dbName}?sslmode=require`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
