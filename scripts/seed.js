import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema, pool } from '../src/db.js';
import { importWorkbook } from '../src/importer.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || path.join(root, 'DEMO_Attendance_data_v1.0.xlsx');

await initSchema();
const result = await importWorkbook(fs.readFileSync(file));
console.log(`Imported ${path.basename(file)}:`, result);
await pool.end();
