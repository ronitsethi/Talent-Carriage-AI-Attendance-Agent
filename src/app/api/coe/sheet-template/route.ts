import { getSession, isPlatformAdmin } from '@/lib/auth';
import { templateWorkbook } from '@/lib/query-types';

/** A sample training sheet, for staff to fill in and upload on COE Teams. */
export async function GET() {
  const session = await getSession();
  if (!session || !isPlatformAdmin(session)) return new Response('Only Talent Carriage staff can download this', { status: 403 });
  const file = templateWorkbook();
  return new Response(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="query-types-template.xlsx"',
      'Content-Length': String(file.length),
      'Cache-Control': 'no-store',
    },
  });
}
