import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { tenants, tenantSettings } from '@/db/schema';
import { answerQuestion, employeeByNumber } from '@/lib/knowledge';
import { questionXml, speakAndHangupXml, xmlResponse } from '@/lib/voice/xml';
import { env } from '@/lib/env';
import { voiceLines } from '@/lib/voice/say';

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

  const result = await withPlatformScope(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
    for (const tenant of all) {
      const found = await withTenant(tenant.id, async (t) => {
        const employee = await employeeByNumber(t, tenant.id, from);
        if (!employee) return null;
        const answer = await answerQuestion(t, tenant.id, said, {
          employeeId: employee.id,
          employeeName: employee.fullName,
        });
        const settings = await t.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, tenant.id) });
        return {
          text: answer.text,
          voice: { speaker: settings?.agentVoice ?? 'ritu', pace: Number(settings?.agentVoicePace ?? 0.95) },
        };
      });
      if (found) return found;
    }
    return null;
  }).catch(() => null);

  const text = result?.text ?? 'Sorry, something went wrong at our end. Please contact your H R team.';
  const more = 'Is there anything else?';
  const voice = result?.voice ?? { speaker: 'ritu', pace: 0.95 };

  const audio = await voiceLines(
    [text, more, 'Sorry, I did not catch that. Please say it once more.', 'I could not hear you. Please call again, or contact your H R team. Goodbye.'],
    voice,
    env.APP_BASE_URL,
  );

  return xmlResponse(
    questionXml({
      intro: text,
      speak: more,
      audio,
      actionUrl: `${env.APP_BASE_URL}/api/voice/ask?from=${encodeURIComponent(from)}`,
      timeoutSeconds: 15,
    }),
  );
}

export const GET = POST;
