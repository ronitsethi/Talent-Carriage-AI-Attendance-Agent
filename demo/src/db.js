import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Keep DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text, params) => pool.query(text, params);

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'schema.sql');
export async function initSchema() {
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
}

export async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(key, value) {
  await q(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)],
  );
}
