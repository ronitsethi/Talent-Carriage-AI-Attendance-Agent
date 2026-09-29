import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { tenants } from '@/db/schema';
import { answerQuestion, employeeByNumber } from '@/lib/knowledge';
import { promptXml, speakAndHangupXml, xmlResponse } from '@/lib/voice/xml';
import { env } from '@/lib/env';

/**
 * One spoken question on an incoming call, answered and then asked for another.
 *
 * The caller is looked up again from their number rather than carried in the
 * URL: a link somebody can edit must never be what decides whose attendance is
 * read out.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const form = await request.formData().catch(() => new FormData());
  const said = String(form.get('Speech') ?? '').trim();

  if (!said) {
    return xmlResponse(speakAndHangupXml('I did not catch that. Please call again, or contact your H R team. Goodbye.'));
  }
  if (/^(no|nothing|that is all|bye|thank you|thanks)\b/i.test(said)) {
    return xmlResponse(speakAndHangupXml('Glad to help. Goodbye.'));
  }

  const answer = await withPlatformScope(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
    for (const tenant of all) {
      const found = await withTenant(tenant.id, async (t) => {
        const employee = await employeeByNumber(t, tenant.id, from);
        if (!employee) return null;
        return answerQuestion(t, tenant.id, said, { employeeId: employee.id, employeeName: employee.fullName });
      });
      if (found) return found;
    }
    return null;
  }).catch(() => null);

  const text = answer?.text ?? 'Sorry, something went wrong at our end. Please contact your H R team.';
  return xmlResponse(
    promptXml({
      intro: text,
      speak: 'Is there anything else?',
      actionUrl: `${env.APP_BASE_URL}/api/voice/ask?from=${encodeURIComponent(from)}`,
      timeoutSeconds: 15,
    }),
  );
}

export const GET = POST;
