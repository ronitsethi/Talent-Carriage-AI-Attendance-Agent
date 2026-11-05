import { NextResponse } from 'next/server';
import { withTenant } from '@/db';
import { canManageSettings, getActiveTenantId, getSession } from '@/lib/auth';
import { isMonth, monthLabel } from '@/lib/locks';
import { payrollWorkbook } from '@/lib/payroll';

/** A month's payroll as uploaded, without the columns never kept. Admins only: it is everyone's salary. */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  if (!canManageSettings(session)) return NextResponse.json({ error: 'Only an admin can download payroll' }, { status: 403 });
  const tenantId = await getActiveTenantId(session);
  const month = new URL(request.url).searchParams.get('month') ?? '';
  if (!tenantId || !isMonth(month)) return NextResponse.json({ error: 'Choose a month' }, { status: 400 });

  const file = await withTenant(tenantId, (tx) => payrollWorkbook(tx, tenantId, month));
  if (!file) return NextResponse.json({ error: `No payroll has been uploaded for ${monthLabel(month)}` }, { status: 404 });
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Payroll-${month}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
