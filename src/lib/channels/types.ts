/**
 * One interface for every messaging provider.
 *
 * The product only ever speaks this language; Meta, a fake in-memory channel and
 * anything added later all satisfy it. That is what lets the entire platform be
 * built and tested before a single credential exists.
 */

export type Button = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };

/** Business-initiated: WhatsApp only allows pre-approved wording to open a conversation. */
export type OutboundTemplate = {
  kind: 'template';
  to: string;
  templateName: string;
  language: string;
  /** Body variables, in order. */
  variables: string[];
  /** Quick-reply payloads, in button order. Up to 10 on a template. */
  buttonPayloads?: string[];
  /** Rendered text, for the transcript and the portal preview. */
  preview: string;
};

/** Free-form, allowed only inside the 24-hour window after the employee writes. */
export type OutboundText = { kind: 'text'; to: string; body: string };

/** Free-form with reply buttons. WhatsApp caps these at three. */
export type OutboundButtons = { kind: 'buttons'; to: string; body: string; buttons: Button[]; footer?: string };

/**
 * Free-form with a list, which is how the four options are offered inside a
 * conversation: three reply buttons are not enough, a list holds up to ten rows.
 */
export type OutboundList = {
  kind: 'list';
  to: string;
  body: string;
  buttonLabel: string;
  rows: ListRow[];
  header?: string;
  footer?: string;
};

export type Outbound = OutboundTemplate | OutboundText | OutboundButtons | OutboundList;

export type SendResult = {
  providerMessageId: string;
  /** True when nothing left the building: dry run, or the fake channel. */
  simulated: boolean;
};

export type InboundMessage = {
  providerMessageId: string;
  /** Sender in wa_id form: digits with country code. */
  from: string;
  kind: 'text' | 'button' | 'list' | 'voice' | 'other';
  text?: string;
  /** Payload of the button or list row tapped; carries the case it belongs to. */
  selectionId?: string;
  selectionTitle?: string;
  /** The provider id of the message being replied to, when quoted. */
  replyToProviderId?: string;
  receivedAt: Date;
  raw: unknown;
};

export type DeliveryUpdate = {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  at: Date;
};

export type ChannelCapabilities = {
  /** False for the fake channel, so the portal can say so plainly. */
  reachesRealPeople: boolean;
  supportsTemplates: boolean;
  supportsButtons: boolean;
  supportsList: boolean;
  maxButtons: number;
};

export interface MessageChannel {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  send(message: Outbound): Promise<SendResult>;
}

/** Thrown when a provider rejects a send; carries the provider's own wording. */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}
