import { randomUUID } from 'node:crypto';
import type { ChannelCapabilities, MessageChannel, Outbound, SendResult } from './types';

/**
 * The channel the platform is built against: it accepts everything WhatsApp
 * accepts, hands back plausible message ids, and delivers nothing to anyone.
 *
 * Sent messages are kept in memory so the simulator screen can show the
 * conversation exactly as an employee would see it, and tests can assert on what
 * would have gone out.
 */
export class FakeChannel implements MessageChannel {
  readonly name = 'fake';
  readonly capabilities: ChannelCapabilities = {
    reachesRealPeople: false,
    supportsTemplates: true,
    supportsButtons: true,
    supportsList: true,
    maxButtons: 3,
  };

  private readonly sent: { at: Date; message: Outbound; providerMessageId: string }[] = [];

  async send(message: Outbound): Promise<SendResult> {
    validateForWhatsApp(message);
    const providerMessageId = `fake.${randomUUID()}`;
    this.sent.push({ at: new Date(), message, providerMessageId });
    return { providerMessageId, simulated: true };
  }

  /** Everything this channel has "sent", newest last. */
  history(to?: string) {
    return to ? this.sent.filter((s) => s.message.to === to) : [...this.sent];
  }

  clear() {
    this.sent.length = 0;
  }
}

/**
 * The same limits WhatsApp enforces, applied by the fake channel too.
 *
 * Without this, code written against the fake would pass locally and fail the
 * day real credentials arrive — which is exactly the trap this build order has
 * to avoid.
 */
export function validateForWhatsApp(message: Outbound): void {
  const tooLong = (value: string, max: number, what: string) => {
    if (value.length > max) throw new Error(`${what} is ${value.length} characters; WhatsApp allows ${max}`);
  };

  if (!/^\d{8,15}$/.test(message.to)) {
    throw new Error(`Recipient "${message.to}" is not digits with a country code`);
  }

  switch (message.kind) {
    case 'template':
      if (!message.templateName) throw new Error('A template message needs a template name');
      message.variables.forEach((v, i) => tooLong(v, 1024, `Template variable ${i + 1}`));
      if ((message.buttonPayloads?.length ?? 0) > 10) throw new Error('A template allows at most 10 buttons');
      break;
    case 'text':
      tooLong(message.body, 4096, 'Message body');
      break;
    case 'buttons':
      tooLong(message.body, 1024, 'Message body');
      if (message.buttons.length === 0 || message.buttons.length > 3) {
        throw new Error(`Reply buttons must be 1-3; got ${message.buttons.length}. Use a list for more.`);
      }
      message.buttons.forEach((b) => tooLong(b.title, 20, `Button "${b.title}"`));
      break;
    case 'list':
      tooLong(message.body, 4096, 'Message body');
      tooLong(message.buttonLabel, 20, 'List button label');
      if (message.rows.length === 0 || message.rows.length > 10) {
        throw new Error(`A list needs 1-10 rows; got ${message.rows.length}`);
      }
      message.rows.forEach((r) => {
        tooLong(r.title, 24, `List row "${r.title}"`);
        if (r.description) tooLong(r.description, 72, `Description of "${r.title}"`);
      });
      break;
  }
}
