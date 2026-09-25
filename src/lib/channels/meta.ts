import crypto from 'node:crypto';
import { ChannelError, type ChannelCapabilities, type DeliveryUpdate, type InboundMessage, type MessageChannel, type Outbound, type SendResult } from './types';
import { validateForWhatsApp } from './fake';

export type MetaConfig = {
  phoneNumberId: string;
  accessToken: string;
  graphVersion?: string;
  /** When true the request is built and validated but never sent. */
  dryRun?: boolean;
};

/**
 * WhatsApp Cloud API. Written in full now and exercised through its request
 * builder in tests; the only thing it waits for is a token.
 */
export class MetaWhatsAppChannel implements MessageChannel {
  readonly name = 'meta_cloud';
  readonly capabilities: ChannelCapabilities = {
    reachesRealPeople: true,
    supportsTemplates: true,
    supportsButtons: true,
    supportsList: true,
    maxButtons: 3,
  };

  constructor(private readonly config: MetaConfig) {}

  async send(message: Outbound): Promise<SendResult> {
    validateForWhatsApp(message);
    const body = buildMetaPayload(message);

    if (this.config.dryRun) {
      return { providerMessageId: `dry.${crypto.randomUUID()}`, simulated: true };
    }

    const version = this.config.graphVersion ?? 'v23.0';
    const url = `https://graph.facebook.com/${version}/${this.config.phoneNumberId}/messages`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      // Network trouble is worth retrying; a rejection by Meta usually is not.
      throw new ChannelError(`WhatsApp request failed: ${(cause as Error).message}`, 'network', true);
    }

    const json = (await response.json().catch(() => ({}))) as {
      messages?: { id: string }[];
      error?: { message?: string; code?: number; error_user_msg?: string };
    };

    if (!response.ok) {
      const err = json.error ?? {};
      throw new ChannelError(
        err.error_user_msg || err.message || `WhatsApp returned HTTP ${response.status}`,
        err.code ?? response.status,
        response.status >= 500 || response.status === 429,
      );
    }

    const id = json.messages?.[0]?.id;
    if (!id) throw new ChannelError('WhatsApp accepted the message but returned no id', 'no_id', false);
    return { providerMessageId: id, simulated: false };
  }
}

/** Builds the Graph API request body. Pure, so it can be asserted on in tests. */
export function buildMetaPayload(message: Outbound): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: message.to };

  switch (message.kind) {
    case 'template': {
      const components: Record<string, unknown>[] = [
        {
          type: 'body',
          parameters: message.variables.map((text) => ({ type: 'text', text })),
        },
      ];
      (message.buttonPayloads ?? []).forEach((payload, index) => {
        components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload }],
        });
      });
      return {
        ...base,
        type: 'template',
        template: {
          name: message.templateName,
          language: { code: message.language },
          components,
        },
      };
    }
    case 'text':
      return { ...base, type: 'text', text: { preview_url: false, body: message.body } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: {
            buttons: message.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
          },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
          body: { text: message.body },
          ...(message.footer ? { footer: { text: message.footer } } : {}),
          action: {
            button: message.buttonLabel,
            sections: [
              {
                title: 'Options',
                rows: message.rows.map((r) => ({
                  id: r.id,
                  title: r.title,
                  ...(r.description ? { description: r.description } : {}),
                })),
              },
            ],
          },
        },
      };
  }
}

/** Confirms a webhook call really came from Meta. */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type MetaWebhookBody = {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Record<string, any>[];
        statuses?: Record<string, any>[];
      };
    }[];
  }[];
};

/** Turns a Meta webhook body into our own message and delivery types. */
export function parseMetaWebhook(body: unknown): {
  phoneNumberId?: string;
  messages: InboundMessage[];
  statuses: DeliveryUpdate[];
} {
  const parsed = body as MetaWebhookBody;
  const messages: InboundMessage[] = [];
  const statuses: DeliveryUpdate[] = [];
  let phoneNumberId: string | undefined;

  for (const entry of parsed?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value ?? {};
      phoneNumberId ??= value.metadata?.phone_number_id;

      for (const raw of value.messages ?? []) {
        const at = raw.timestamp ? new Date(Number(raw.timestamp) * 1000) : new Date();
        const common = {
          providerMessageId: String(raw.id),
          from: String(raw.from),
          replyToProviderId: raw.context?.id ? String(raw.context.id) : undefined,
          receivedAt: at,
          raw,
        };

        if (raw.type === 'button') {
          // Template quick-reply: the payload is ours, so it names the case.
          messages.push({
            ...common,
            kind: 'button',
            selectionId: raw.button?.payload ? String(raw.button.payload) : undefined,
            selectionTitle: raw.button?.text ? String(raw.button.text) : undefined,
            text: raw.button?.text ? String(raw.button.text) : undefined,
          });
        } else if (raw.type === 'interactive') {
          const reply = raw.interactive?.button_reply ?? raw.interactive?.list_reply;
          messages.push({
            ...common,
            kind: raw.interactive?.list_reply ? 'list' : 'button',
            selectionId: reply?.id ? String(reply.id) : undefined,
            selectionTitle: reply?.title ? String(reply.title) : undefined,
            text: reply?.title ? String(reply.title) : undefined,
          });
        } else if (raw.type === 'text') {
          messages.push({ ...common, kind: 'text', text: String(raw.text?.body ?? '') });
        } else if (raw.type === 'audio' || raw.type === 'voice') {
          messages.push({ ...common, kind: 'voice' });
        } else {
          messages.push({ ...common, kind: 'other', text: raw.type ? `[${raw.type}]` : undefined });
        }
      }

      for (const raw of value.statuses ?? []) {
        const error = raw.errors?.[0];
        statuses.push({
          providerMessageId: String(raw.id),
          status: raw.status === 'failed' ? 'failed' : (raw.status as DeliveryUpdate['status']),
          error: error ? `${error.code}: ${error.title ?? error.message ?? 'failed'}` : undefined,
          at: raw.timestamp ? new Date(Number(raw.timestamp) * 1000) : new Date(),
        });
      }
    }
  }

  return { phoneNumberId, messages, statuses };
}
