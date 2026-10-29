import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import { costLines, messages, ticketMessages } from '@/db/schema';
import { env } from '@/lib/env';
import { WHATSAPP } from './prices';

/**
 * What a call or a chat cost, laid out to be read under its transcript: one
 * group per call or per message, each with what went into it.
 *
 * Everything is shown in rupees. Lines priced in dollars - Azure, LiveKit -
 * are converted at USD_INR_RATE, and keep the dollar figure beside them.
 */

export type CostRow = {
  provider: string;
  item: string;
  /** e.g. "1,240 tokens", "95 seconds", "3 requests". */
  quantity: string;
  /** Null when there is no price on file for it. */
  inr: number | null;
  /** The amount as priced, when it was not in rupees. */
  original?: string;
  estimated: boolean;
  note?: string;
};

export type CostGroup = { key: string; title: string; at?: Date | null; rows: CostRow[]; inr: number };
export type CostBox = { groups: CostGroup[]; inr: number; estimated: boolean; unpriced: boolean; rate: number };

type Line = typeof costLines.$inferSelect;
type Message = typeof messages.$inferSelect;

const RATE = () => env.USD_INR_RATE;
const toInr = (micros: number | null, currency: string) =>
  micros === null ? null : (micros / 1_000_000) * (currency === 'USD' ? RATE() : 1);
const count = (n: number) => Math.round(n).toLocaleString('en-IN');
const dollarsLabel = (micros: number) => (micros < 100 ? '<$0.0001' : `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 5 : 4)}`);

/** Lines for the same thing added up, so twelve turns of a call read as one row. */
function rowsOf(lines: Line[]): CostRow[] {
  const merged = new Map<string, { line: Line; quantity: number; micros: number | null; times: number; cached: number }>();
  for (const line of lines) {
    const key = `${line.provider}|${line.item}|${line.unit}|${line.currency}`;
    const seen = merged.get(key);
    if (seen) {
      seen.quantity += line.quantity;
      seen.micros = seen.micros === null || line.amountMicros === null ? null : seen.micros + line.amountMicros;
      seen.times += 1;
      seen.cached += Number(line.detail?.cachedInputTokens ?? 0);
      seen.line = { ...seen.line, estimated: seen.line.estimated || line.estimated };
    } else {
      merged.set(key, { line, quantity: line.quantity, micros: line.amountMicros, times: 1, cached: Number(line.detail?.cachedInputTokens ?? 0) });
    }
  }
  return [...merged.values()].map(({ line, quantity, micros, times, cached }) => ({
    provider: line.provider,
    item: line.item,
    quantity: `${count(quantity)} ${line.unit}${times > 1 && line.unit === 'tokens' ? ` · ${times} requests` : ''}`,
    inr: toInr(micros, line.currency),
    original: line.currency === 'USD' && micros !== null ? dollarsLabel(micros) : undefined,
    estimated: line.estimated,
    note:
      typeof line.detail?.rate === 'string'
        ? line.detail.rate
        : typeof line.detail?.source === 'string'
          ? line.detail.source
          : cached
            ? `${count(cached)} of the input tokens reused from Azure's cache, at a quarter of the price`
            : undefined,
  }));
}

function group(key: string, title: string, rows: CostRow[], at?: Date | null): CostGroup {
  return { key, title, at, rows, inr: rows.reduce((sum, row) => sum + (row.inr ?? 0), 0) };
}

function box(groups: CostGroup[]): CostBox {
  const kept = groups.filter((g) => g.rows.length);
  const rows = kept.flatMap((g) => g.rows);
  return {
    groups: kept,
    inr: kept.reduce((sum, g) => sum + g.inr, 0),
    estimated: rows.some((row) => row.estimated),
    unpriced: rows.some((row) => row.inr === null),
    rate: RATE(),
  };
}

/**
 * What Meta charges for one message we sent. The delivery receipt says whether
 * it was billable and as what; until it comes, a template is taken to be a
 * charged utility message and a free-form reply to be inside the free tier.
 */
export function whatsappFee(message: Pick<Message, 'direction' | 'status' | 'kind' | 'templateName' | 'pricing'>): CostRow | null {
  const base = { provider: 'WhatsApp (Meta)', quantity: '1 message' };
  // Meta charges only for what a business sends; a reply is free to receive.
  if (message.direction !== 'outbound') {
    return { ...base, item: 'Received message', inr: 0, estimated: false, note: 'Free: Meta charges only for messages a business sends' };
  }
  if (message.status === 'simulated') return { ...base, item: 'Message', inr: 0, estimated: false, note: 'Not sent: dry run' };
  if (message.status === 'failed' || message.status === 'queued') {
    return { ...base, item: 'Message', inr: 0, estimated: false, note: 'Not delivered, so not charged' };
  }
  const pricing = message.pricing;
  const kindLabel = message.kind === 'template' ? `Template${message.templateName ? ` ${message.templateName}` : ''}` : 'Free-form message';
  if (pricing?.billable === false) {
    return { ...base, item: kindLabel, inr: 0, estimated: false, note: `Free per Meta's receipt (${pricing.type ?? pricing.category ?? 'not billable'})` };
  }
  if (pricing?.billable && pricing.category) {
    const rate = WHATSAPP.perMessage[pricing.category] ?? WHATSAPP.perMessage.utility!;
    return { ...base, item: kindLabel, inr: rate, estimated: true, note: `Billable as ${pricing.category}, ₹${rate} Meta rate` };
  }
  if (message.kind === 'template') {
    const rate = WHATSAPP.perMessage.utility!;
    return { ...base, item: kindLabel, inr: rate, estimated: true, note: `Utility, ₹${rate} Meta rate` };
  }
  return { ...base, item: kindLabel, inr: 0, estimated: true, note: 'Service message: free for the first 1,000 a month' };
}

/**
 * What a case or a query cost, one section per service - WhatsApp, the AI,
 * speech, the phone line, LiveKit - each with its subtotal and what made it up,
 * added up across every message and call. Not message by message: the
 * question is what the case cost and where the money went.
 */

/** Each service's section, in the order they are read, and what it is called. */
const SERVICES: { provider: string; title: string }[] = [
  { provider: 'WhatsApp (Meta)', title: 'WhatsApp' },
  { provider: 'Azure OpenAI', title: 'AI (Azure OpenAI)' },
  { provider: 'Anthropic', title: 'AI (Anthropic, fallback)' },
  { provider: 'Sarvam', title: 'Speech (Sarvam)' },
  { provider: 'OpenAI', title: 'Speech (OpenAI)' },
  { provider: 'Plivo', title: 'Phone line (Plivo)' },
  { provider: 'LiveKit', title: 'Talking calls (LiveKit)' },
];

type Fee = Pick<Message, 'direction' | 'status' | 'kind' | 'templateName' | 'pricing'> & { to?: 'manager' | 'coe' };

/** WhatsApp's messages, counted by kind: how many, how many were charged, and what they came to. */
function whatsappRows(fees: Fee[]): CostRow[] {
  const kinds = new Map<string, { count: number; charged: number; inr: number; estimated: boolean; free: Set<string> }>();
  for (const message of fees) {
    const fee = whatsappFee(message)!;
    const sentWhat = message.kind === 'template' ? 'Templates sent' : 'Messages sent';
    const label =
      message.direction !== 'outbound'
        ? 'Messages received'
        : message.status === 'simulated' || message.status === 'failed' || message.status === 'queued'
          ? 'Not delivered (dry run or failed)'
          : message.to === 'manager'
            ? `${sentWhat} to the manager`
            : message.to === 'coe'
              ? 'Ticket notices to the COE team'
              : `${sentWhat} to the employee`;
    const kind = kinds.get(label) ?? { count: 0, charged: 0, inr: 0, estimated: false, free: new Set<string>() };
    kind.count += 1;
    kind.inr += fee.inr ?? 0;
    if (fee.inr) {
      kind.charged += 1;
      kind.estimated ||= fee.estimated;
    } else if (message.direction === 'outbound' && fee.note) {
      kind.free.add(fee.note.replace(/^Free per Meta's receipt \((.*)\)$/, 'free: $1'));
    }
    kinds.set(label, kind);
  }
  const order = [
    'Templates sent to the employee',
    'Messages sent to the employee',
    'Templates sent to the manager',
    'Messages sent to the manager',
    'Ticket notices to the COE team',
    'Messages received',
    'Not delivered (dry run or failed)',
  ];
  return [...kinds.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([label, kind]) => ({
    provider: 'WhatsApp (Meta)',
    item: label,
    quantity: `${count(kind.count)} ${kind.count === 1 ? 'message' : 'messages'}`,
    inr: kind.inr,
    estimated: kind.estimated,
    note:
      label === 'Messages received'
        ? 'Free: Meta charges only for messages a business sends'
        : kind.charged
          ? `${kind.charged} charged at ₹${WHATSAPP.perMessage.utility} each${kind.count > kind.charged ? `, ${kind.count - kind.charged} free` : ''}`
          : [...kind.free].join('; ') || 'Free',
  }));
}

function serviceBox(lines: Line[], fees: Fee[]): CostBox {
  const groups: CostGroup[] = [];
  for (const service of SERVICES) {
    // Within a service, the biggest cost first.
    const rows =
      service.provider === 'WhatsApp (Meta)'
        ? whatsappRows(fees)
        : rowsOf(lines.filter((line) => line.provider === service.provider)).sort((a, b) => (b.inr ?? 0) - (a.inr ?? 0));
    if (rows.length) groups.push(group(service.provider, service.title, rows));
  }
  const known = new Set(SERVICES.map((s) => s.provider));
  const rest = lines.filter((line) => !known.has(line.provider));
  if (rest.length) groups.push(group('other', 'Other', rowsOf(rest)));
  return box(groups);
}

const unique = (lines: Line[]) => [...new Map(lines.map((line) => [line.id, line])).values()];

/**
 * Everything a case cost: its chat, every call shown on it, its summary, and
 * the requests to the manager and what they were told, by WhatsApp or call.
 */
export async function caseCostBox(tx: Db, caseId: string, chat: Message[], callIds: string[]): Promise<CostBox> {
  const ids = chat.map((m) => m.providerMessageId).filter((id): id is string => Boolean(id));
  const lines = unique([
    ...(await tx.select().from(costLines).where(eq(costLines.caseId, caseId))),
    ...(callIds.length ? await tx.select().from(costLines).where(inArray(costLines.callId, callIds)) : []),
    ...(ids.length ? await tx.select().from(costLines).where(inArray(costLines.providerMessageId, ids)) : []),
  ]);
  const toManager = await tx
    .select()
    .from(messages)
    .where(and(isNull(messages.caseId), sql`${messages.payload}->>'aboutCaseId' = ${caseId}`));
  return serviceBox(lines, [...chat, ...toManager.map((m) => ({ ...m, to: 'manager' as const }))]);
}

/** Everything a query cost: its call or chat, the feedback after a call, its summary and its ticket. */
export async function queryCostBox(tx: Db, queryId: string, chat: Message[]): Promise<CostBox> {
  const ids = chat.map((m) => m.providerMessageId).filter((id): id is string => Boolean(id));
  const lines = unique([
    ...(await tx.select().from(costLines).where(eq(costLines.queryId, queryId))),
    ...(ids.length ? await tx.select().from(costLines).where(inArray(costLines.providerMessageId, ids)) : []),
  ]);
  // The ticket's WhatsApp messages to the COE team: the three notices are templates.
  const ticket = await tx.select().from(ticketMessages).where(and(eq(ticketMessages.queryId, queryId), eq(ticketMessages.direction, 'outbound')));
  const notices: Fee[] = ticket.map((m) => ({
    direction: 'outbound',
    status: m.status as Message['status'],
    kind: ['assigned', 'reminder', 'escalated'].includes(m.kind) ? 'template' : 'text',
    templateName: null,
    pricing: null,
    to: 'coe',
  }));
  return serviceBox(lines, [...chat, ...notices]);
}
