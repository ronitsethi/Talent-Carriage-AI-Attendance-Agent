import { NextResponse } from 'next/server';
import { withTenant } from '@/db';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { isLocked, isMonth, monthLabel } from '@/lib/locks';
import { attendanceWorkbook } from '@/lib/payroll';

/** A locked month's final attendance, as a spreadsheet. Any signed-in user of the customer. */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  const tenantId = await getActiveTenantId(session);
  const month = new URL(request.url).searchParams.get('month') ?? '';
  if (!tenantId || !isMonth(month)) return NextResponse.json({ error: 'Choose a month' }, { status: 400 });

  const file = await withTenant(tenantId, async (tx) => ((await isLocked(tx, tenantId, `${month}-01`)) ? attendanceWorkbook(tx, tenantId, month) : null));
  if (!file) return NextResponse.json({ error: `${monthLabel(month)} is not locked, so its attendance is not final yet` }, { status: 409 });
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Final-attendance-${month}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
