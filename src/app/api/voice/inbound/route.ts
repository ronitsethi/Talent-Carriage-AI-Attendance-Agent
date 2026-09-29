import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { tenants } from '@/db/schema';
import { employeeByNumber } from '@/lib/knowledge';
import { questionXml, speakAndHangupXml, xmlResponse } from '@/lib/voice/xml';
import { env } from '@/lib/env';

/**
 * Somebody rings the company's number.
 *
 * The caller's number is how they are identified, and it is the only thing that
 * decides whose attendance they can hear about - there is no other way in, and
 * an unrecognised number is told so rather than being offered a menu.
 */
export async function inboundXml(request: Request): Promise<Response> {
  const form = await request.formData().catch(() => new FormData());
  const from = String(form.get('From') ?? new URL(request.url).searchParams.get('From') ?? '');

  const found = await withPlatformScope(async (tx) => {
    // One number per customer for now; the callee decides whose employee list
    // to search once numbers are per tenant.
    const all = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
    for (const tenant of all) {
      const employee = await withTenant(tenant.id, (t) => employeeByNumber(t, tenant.id, from));
      if (employee) return { tenantId: tenant.id, name: employee.fullName };
    }
    return null;
  }).catch(() => null);

  if (!found) {
    return xmlResponse(
      speakAndHangupXml(
        'Sorry, this number is not on our employee records, so I cannot help over the phone. Please contact your H R team. Goodbye.',
      ),
    );
  }

  const first = found.name.split(/\s+/)[0];
  return xmlResponse(
    questionXml({
      intro: `Hello ${first}. This is the attendance assistant.`,
      speak: 'What would you like to know? You can ask about your attendance, or about leave, overtime or the exit process.',
      actionUrl: `${env.APP_BASE_URL}/api/voice/ask?from=${encodeURIComponent(from)}`,
      timeoutSeconds: 20,
    }),
  );
}

export const GET = inboundXml;
export const POST = inboundXml;
