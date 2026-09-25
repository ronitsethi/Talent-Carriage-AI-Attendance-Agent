import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { tenantChannels } from '@/db/schema';
import { parseMetaWebhook, verifyMetaSignature } from '@/lib/channels/meta';
import { applyDeliveryUpdate, handleInbound } from '@/lib/conversation/engine';
import { buildContext } from '@/lib/runtime';
import { env } from '@/lib/env';

/**
 * Meta's webhook.
 *
 * Verification on GET, signature check on POST, then the work happens after the
 * response is already on its way back - Meta retries anything we are slow to
 * acknowledge, and a retry would otherwise look like a second reply.
 */

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token && env.WA_VERIFY_TOKEN && token === env.WA_VERIFY_TOKEN) {
    console.log('[webhook] verified by Meta');
    return new NextResponse(challenge ?? '', { status: 200 });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
  const raw = await request.text();

  if (env.WA_APP_SECRET) {
    const signature = request.headers.get('x-hub-signature-256');
    if (!verifyMetaSignature(raw, signature, env.WA_APP_SECRET)) {
      console.warn('[webhook] rejected: bad signature');
      return new NextResponse('Invalid signature', { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse('Bad JSON', { status: 400 });
  }

  // Acknowledge first; process without blocking the response.
  void process(body).catch((error) => console.error('[webhook] processing failed:', error));
  return NextResponse.json({ received: true });
}

async function process(body: unknown) {
  const { phoneNumberId, messages, statuses } = parseMetaWebhook(body);
  if (!messages.length && !statuses.length) return;

  const tenantId = await resolveTenant(phoneNumberId);
  if (!tenantId) {
    console.warn(`[webhook] no customer is configured for phone number id ${phoneNumberId ?? 'unknown'}`);
    return;
  }

  await withTenant(tenantId, async (tx) => {
    for (const status of statuses) {
      await applyDeliveryUpdate(tx, tenantId, status);
    }
    if (messages.length) {
      const ctx = await buildContext(tx, tenantId);
      for (const message of messages) {
        const outcome = await handleInbound(ctx, message);
        console.log(`[webhook] ${message.from}:`, JSON.stringify(outcome));
      }
    }
  });
}

/** Which customer owns the number Meta delivered this to. */
async function resolveTenant(phoneNumberId: string | undefined): Promise<string | null> {
  if (phoneNumberId) {
    const match = await withPlatformScope((tx) =>
      tx
        .select({ tenantId: tenantChannels.tenantId })
        .from(tenantChannels)
        .where(sql`${tenantChannels.config}->>'phoneNumberId' = ${phoneNumberId}`)
        .limit(1),
    );
    if (match[0]) return match[0].tenantId;
  }

  // Single-customer installs (and the first pilot) need no mapping at all.
  const all = await withPlatformScope((tx) => tx.select({ tenantId: tenantChannels.tenantId }).from(tenantChannels).limit(2));
  return all.length === 1 ? all[0]!.tenantId : null;
}
