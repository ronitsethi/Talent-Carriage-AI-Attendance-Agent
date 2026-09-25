import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { capabilities } from '@/lib/env';

/** Liveness plus a plain statement of what is actually wired up. */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, database: 'up', ...capabilities() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, database: 'down', error: (error as Error).message },
      { status: 503 },
    );
  }
}
