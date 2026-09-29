import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { tenants, tenantSettings } from '@/db/schema';
import { employeeByNumber } from '@/lib/knowledge';
import { questionXml, speakAndHangupXml, xmlResponse } from '@/lib/voice/xml';
import { env } from '@/lib/env';
import { voiceLines } from '@/lib/voice/say';

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
      if (employee) {
        const settings = await withTenant(tenant.id, (t) =>
          t.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, tenant.id) }),
        );
        return {
          tenantId: tenant.id,
          name: employee.fullName,
          voice: { speaker: settings?.agentVoice ?? 'ritu', pace: Number(settings?.agentVoicePace ?? 0.95) },
        };
      }
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
  const intro = `Hello ${first}. This is the attendance assistant.`;
  const question =
    'What would you like to know? You can ask about your attendance, or about leave, overtime or the exit process.';

  // Spoken in the voice chosen in Settings, so an incoming call sounds like the
  // same company as an outgoing one rather than like Plivo.
  const audio = await voiceLines(
    [intro, question, 'Sorry, I did not catch that. Please say it once more.', 'I could not hear you. Please call again, or contact your H R team. Goodbye.'],
    found.voice,
    env.APP_BASE_URL,
  );

  return xmlResponse(
    questionXml({
      intro,
      speak: question,
      audio,
      actionUrl: `${env.APP_BASE_URL}/api/voice/ask?from=${encodeURIComponent(from)}`,
      timeoutSeconds: 20,
    }),
  );
}

export const GET = inboundXml;
export const POST = inboundXml;
