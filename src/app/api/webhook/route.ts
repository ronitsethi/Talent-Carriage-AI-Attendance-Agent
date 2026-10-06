import { NextResponse } from 'next/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { employees, messages as messageLog, tenantChannels } from '@/db/schema';
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

  const tenantId = await resolveTenant(phoneNumberId, {
    sender: messages[0]?.from,
    messageIds: statuses.map((s) => s.providerMessageId),
  });
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

/**
 * Which customer this delivery belongs to.
 *
 * A customer with its own number is found by that number. Customers sharing the
 * platform's number are told apart by the conversation itself: a status names a
 * message we sent, and a reply comes from someone we last wrote to.
 */
async function resolveTenant(
  phoneNumberId: string | undefined,
  hint: { sender?: string; messageIds: string[] },
): Promise<string | null> {
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
  if (all.length === 1) return all[0]!.tenantId;

  return withPlatformScope(async (tx) => {
    if (hint.messageIds.length) {
      const [sent] = await tx
        .select({ tenantId: messageLog.tenantId })
        .from(messageLog)
        .where(inArray(messageLog.providerMessageId, hint.messageIds))
        .limit(1);
      if (sent) return sent.tenantId;
    }
    if (!hint.sender) return null;

    const [lastWrittenTo] = await tx
      .select({ tenantId: messageLog.tenantId })
      .from(messageLog)
      .where(and(eq(messageLog.waId, hint.sender), eq(messageLog.direction, 'outbound')))
      .orderBy(desc(messageLog.createdAt))
      .limit(1);
    if (lastWrittenTo) return lastWrittenTo.tenantId;

    // Someone writing first: theirs only if exactly one customer employs them.
    const employers = await tx
      .selectDistinct({ tenantId: employees.tenantId })
      .from(employees)
      .where(eq(employees.mobileE164, hint.sender))
      .limit(2);
    return employers.length === 1 ? employers[0]!.tenantId : null;
  });
}
