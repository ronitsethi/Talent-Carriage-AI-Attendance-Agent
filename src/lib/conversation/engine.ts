import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '@/db';
import {
  cases,
  conversations,
  consentEvents,
  employees,
  messages,
  usageEvents,
  aiDecisions,
  type tenantSettings,
} from '@/db/schema';
import type { MessageChannel, InboundMessage, Outbound } from '@/lib/channels/types';
import { ChannelError } from '@/lib/channels/types';
import type { Meaning } from '@/lib/mapping/meanings';
import { classifyReply, type Classification } from './classify';
import {
  allClearedMessage,
  backlogSummary,
  buildFirstStepTemplate,
  buildOptionList,
  clarifyMessage,
  dateLabel,
  firstName,
  handedToHrMessage,
  optOutConfirmation,
  systemReply,
  parseSelectionId,
  parseApprovalSelectionId,
  parseFollowUpSelectionId,
  parseOfferSelectionId,
  type OptionNumber,
} from './flow';

export type TenantSettings = typeof tenantSettings.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type EmployeeRow = typeof employees.$inferSelect;

/**
 * The engine never imports the action engine: actions plug in here instead.
 * That keeps the conversation layer independent, and lets a tenant run with
 * actions switched off simply by leaving the hooks unset.
 */
export type EngineHooks = {
  /** Returns true when an offer was made, so the backlog chain waits its turn. */
  onAnswered?(ctx: EngineContext, caseRow: CaseRow, employee: EmployeeRow, option: OptionNumber): Promise<boolean>;
  onOfferResponse?(
    ctx: EngineContext,
    caseRow: CaseRow,
    employee: EmployeeRow,
    choice: 'accept' | 'self' | 'other_type',
  ): Promise<void>;
  onApprovalDecision?(
    ctx: EngineContext,
    approvalId: string,
    choice: 'approve' | 'reject' | 'details',
    approver: EmployeeRow,
  ): Promise<void>;
  onFollowUpResponse?(
    ctx: EngineContext,
    caseRow: CaseRow,
    employee: EmployeeRow,
    choice: 'done' | 'not_done' | 'help',
  ): Promise<void>;
};

export type EngineContext = {
  tx: Db;
  tenantId: string;
  settings: TenantSettings;
  channel: MessageChannel;
  companyName: string;
  template: { name: string; language: string; buttonCount: number };
  hooks?: EngineHooks;
  now?: () => Date;
};

/** Statuses meaning "asked, and the employee has not answered yet". */
export const UNANSWERED = ['queued', 'asked', 'delivered', 'read'] as const;
const WINDOW_HOURS = 24;

const now = (ctx: EngineContext) => ctx.now?.() ?? new Date();

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

export type SendBlock = { blocked: true; reason: string } | { blocked: false };

/**
 * Nothing is sent without passing here: the tenant's master switch, the
 * employee's opt-out, a usable number, and quiet hours.
 */
export function canSend(ctx: EngineContext, employee: EmployeeRow): SendBlock {
  if (!ctx.settings.sendingEnabled) return { blocked: true, reason: 'Sending is switched off for this customer' };
  if (employee.whatsappOptOut) return { blocked: true, reason: 'Employee has opted out of messages' };
  if (!employee.mobileE164) return { blocked: true, reason: 'No mobile number on record' };
  if (inQuietHours(ctx)) return { blocked: true, reason: 'Quiet hours' };
  return { blocked: false };
}

export function inQuietHours(ctx: EngineContext, at = now(ctx)): boolean {
  const { quietHoursStart, quietHoursEnd, timezone } = ctx.settings;
  if (!quietHoursStart || !quietHoursEnd) return false;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);

  const start = quietHoursStart.slice(0, 5);
  const end = quietHoursEnd.slice(0, 5);
  // Quiet hours usually wrap midnight (20:00 to 09:00).
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

/* ------------------------------------------------------------------ *
 * Conversations and the 24-hour window
 * ------------------------------------------------------------------ */

export async function getConversation(ctx: EngineContext, employeeId: string) {
  const existing = await ctx.tx.query.conversations.findFirst({
    where: and(eq(conversations.employeeId, employeeId), eq(conversations.channel, 'whatsapp')),
  });
  if (existing) return existing;
  const [created] = await ctx.tx
    .insert(conversations)
    .values({ tenantId: ctx.tenantId, employeeId, channel: 'whatsapp' })
    .returning();
  return created!;
}

/**
 * True while WhatsApp allows free-form messages: 24 hours from the employee's
 * last inbound message. Outside it, only an approved template may be sent.
 */
export function windowOpen(conversation: { windowExpiresAt: Date | null }, at = new Date()): boolean {
  return Boolean(conversation.windowExpiresAt && conversation.windowExpiresAt > at);
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

async function deliver(
  ctx: EngineContext,
  employee: EmployeeRow,
  message: Outbound,
  meta: { caseId?: string | null; kind: 'template' | 'text' | 'interactive'; body: string; templateName?: string },
) {
  const conversation = await getConversation(ctx, employee.id);
  const [row] = await ctx.tx
    .insert(messages)
    .values({
      tenantId: ctx.tenantId,
      conversationId: conversation.id,
      caseId: meta.caseId ?? null,
      direction: 'outbound',
      channel: 'whatsapp',
      kind: meta.kind,
      status: 'queued',
      templateName: meta.templateName,
      language: ctx.template.language,
      body: meta.body,
      buttons: message.kind === 'list' ? message.rows.map((r) => ({ id: r.id, title: r.title })) : undefined,
      waId: employee.mobileE164,
    })
    .returning();

  try {
    const result = await ctx.channel.send(message);
    await ctx.tx
      .update(messages)
      .set({
        providerMessageId: result.providerMessageId,
        status: result.simulated ? 'simulated' : 'sent',
        sentAt: now(ctx),
      })
      .where(eq(messages.id, row!.id));

    await ctx.tx.insert(usageEvents).values({
      tenantId: ctx.tenantId,
      kind: meta.kind === 'template' ? 'whatsapp_conversation' : 'whatsapp_message',
      channel: 'whatsapp',
      meta: { simulated: result.simulated, caseId: meta.caseId ?? null },
    });

    await ctx.tx
      .update(conversations)
      .set({ lastOutboundAt: now(ctx), updatedAt: now(ctx) })
      .where(eq(conversations.id, conversation.id));

    return { messageId: row!.id, providerMessageId: result.providerMessageId, simulated: result.simulated };
  } catch (error) {
    const reason = error instanceof ChannelError ? error.message : (error as Error).message;
    await ctx.tx.update(messages).set({ status: 'failed', error: reason }).where(eq(messages.id, row!.id));
    throw error;
  }
}

/**
 * Asks about one date.
 *
 * Outside the 24-hour window this must be the approved template. Inside it, the
 * same question goes as a list, which costs nothing extra and is how a backlog
 * gets worked through in one sitting.
 */
export async function askCase(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  opts: { remaining?: number; body?: string } = {},
) {
  const block = canSend(ctx, employee);
  if (block.blocked) {
    await ctx.tx.update(cases).set({ error: block.reason, updatedAt: now(ctx) }).where(eq(cases.id, caseRow.id));
    return { sent: false as const, reason: block.reason };
  }

  const conversation = await getConversation(ctx, employee.id);
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const useSession = windowOpen(conversation, now(ctx));

  const message = useSession
    ? buildOptionList({
        to: employee.mobileE164!,
        employeeName: employee.fullName,
        label,
        caseId: caseRow.id,
        remaining: opts.remaining ?? 1,
        body: opts.body,
      })
    : buildFirstStepTemplate({
        to: employee.mobileE164!,
        templateName: ctx.template.name,
        language: ctx.template.language,
        employeeName: employee.fullName,
        label,
        caseId: caseRow.id,
        buttonCount: ctx.template.buttonCount,
      });

  const body = message.kind === 'template' ? message.preview : message.body;
  const sent = await deliver(ctx, employee, message, {
    caseId: caseRow.id,
    kind: useSession ? 'interactive' : 'template',
    body,
    templateName: useSession ? undefined : ctx.template.name,
  });

  await ctx.tx
    .update(cases)
    .set({
      status: 'asked',
      askedAt: caseRow.askedAt ?? now(ctx),
      firstMessageId: caseRow.firstMessageId ?? sent.messageId,
      error: null,
      updatedAt: now(ctx),
    })
    .where(eq(cases.id, caseRow.id));

  await ctx.tx
    .update(conversations)
    .set({ activeCaseId: caseRow.id, updatedAt: now(ctx) })
    .where(eq(conversations.id, conversation.id));

  return { sent: true as const, ...sent, viaTemplate: !useSession };
}

/** Plain text inside the 24-hour window. */
export async function sendPlainText(
  ctx: EngineContext,
  employee: EmployeeRow,
  body: string,
  caseId?: string | null,
) {
  return deliver(ctx, employee, { kind: 'text', to: employee.mobileE164!, body }, { caseId, kind: 'text', body });
}

/** Up to three reply buttons: offers, approvals and the day-2 follow-up. */
export async function sendButtons(
  ctx: EngineContext,
  employee: EmployeeRow,
  body: string,
  buttons: { id: string; title: string }[],
  caseId?: string | null,
) {
  return deliver(
    ctx,
    employee,
    { kind: 'buttons', to: employee.mobileE164!, body, buttons },
    { caseId, kind: 'interactive', body },
  );
}

const sendText = sendPlainText;

/* ------------------------------------------------------------------ *
 * The backlog chain
 * ------------------------------------------------------------------ */

/** Every date this employee still has to answer, oldest first. */
export async function pendingCases(ctx: EngineContext, employeeId: string, excludeCaseId?: string) {
  const rows = await ctx.tx
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.employeeId, employeeId),
        inArray(cases.status, [...UNANSWERED]),
        excludeCaseId ? sql`${cases.id} <> ${excludeCaseId}` : sql`true`,
      ),
    )
    .orderBy(asc(cases.attDate));
  return rows;
}

/**
 * How many questions this employee already has outstanding.
 *
 * With `maxOutstandingQuestions` at 0 there is no cap: every absent date is
 * asked as it is found and they pile up, which is the agreed behaviour. A cap
 * holds the extras in `queued` and this is what decides when one is released.
 */
export async function outstandingCount(ctx: EngineContext, employeeId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(cases)
    .where(and(eq(cases.employeeId, employeeId), inArray(cases.status, ['asked', 'delivered', 'read'])));
  return row?.count ?? 0;
}

export function capAllows(settings: TenantSettings, outstanding: number): boolean {
  const cap = settings.maxOutstandingQuestions;
  return cap <= 0 || outstanding < cap;
}

/**
 * Run straight after a date is answered: tell the employee what is still
 * pending and ask about the next one, in the same conversation.
 *
 * This is the only nudge the remaining dates ever get - they are never chased
 * on their own - so it matters that it happens immediately while the employee
 * is engaged and the free window is open.
 */
export async function chainNextPending(ctx: EngineContext, employee: EmployeeRow, justAnsweredCaseId: string) {
  if (!ctx.settings.sendBacklogSummary) return { asked: null };

  const pending = await pendingCases(ctx, employee.id, justAnsweredCaseId);
  if (!pending.length) {
    const [answered] = await ctx.tx
      .select({ count: sql<number>`count(*)::int` })
      .from(cases)
      .where(and(eq(cases.employeeId, employee.id), eq(cases.status, 'answered')));
    if ((answered?.count ?? 0) > 1) {
      await sendText(ctx, employee, allClearedMessage(answered?.count ?? 1));
    }
    return { asked: null };
  }

  const next = pending[0]!;
  const labels = pending.map((c) => dateLabel(c.attDate, c.meaning as Meaning));
  const summary = backlogSummary(pending.length, labels);
  const label = dateLabel(next.attDate, next.meaning as Meaning);

  // One message: the summary and the next question together, so the employee
  // sees the size of the backlog and can answer it immediately.
  const body = `${summary}\n\n${firstName(employee.fullName)}, about ${label} — please choose one option below.`;
  const result = await askCase(ctx, next, employee, { remaining: pending.length, body });
  return { asked: result.sent ? next : null, remaining: pending.length };
}

/* ------------------------------------------------------------------ *
 * Inbound
 * ------------------------------------------------------------------ */

export type InboundOutcome =
  | { handled: false; reason: 'duplicate' | 'unknown_sender' | 'no_case' }
  | {
      handled: true;
      caseId: string | null;
      classification: Classification;
      action: 'answered' | 'clarified' | 'opted_out' | 'handed_to_hr' | 'logged';
    };

/**
 * Handles one incoming message: record it, work out which date it is about,
 * understand it, answer it, and move the backlog along.
 */
export async function handleInbound(ctx: EngineContext, inbound: InboundMessage): Promise<InboundOutcome> {
  const employee = await ctx.tx.query.employees.findFirst({
    where: and(eq(employees.tenantId, ctx.tenantId), eq(employees.mobileE164, inbound.from)),
  });
  if (!employee) return { handled: false, reason: 'unknown_sender' };

  const conversation = await getConversation(ctx, employee.id);

  // Record first, and let the unique provider id reject Meta's retries.
  const inserted = await ctx.tx
    .insert(messages)
    .values({
      tenantId: ctx.tenantId,
      conversationId: conversation.id,
      direction: 'inbound',
      channel: 'whatsapp',
      kind: inbound.kind === 'text' ? 'text' : 'interactive',
      status: 'received',
      providerMessageId: inbound.providerMessageId,
      replyToProviderId: inbound.replyToProviderId,
      waId: inbound.from,
      body: inbound.text ?? inbound.selectionTitle ?? '',
      payload: inbound.raw as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: messages.providerMessageId })
    .returning();
  if (!inserted.length) return { handled: false, reason: 'duplicate' };
  const inboundRow = inserted[0]!;

  // The employee wrote to us, so free-form replies are allowed for 24 hours.
  const expires = new Date(inbound.receivedAt.getTime() + WINDOW_HOURS * 3600_000);
  await ctx.tx
    .update(conversations)
    .set({ lastInboundAt: inbound.receivedAt, windowExpiresAt: expires, updatedAt: now(ctx) })
    .where(eq(conversations.id, conversation.id));

  // A manager approving, or an employee answering an offer: both name their own
  // record in the payload, so they are routed before any case matching happens.
  const approval = parseApprovalSelectionId(inbound.selectionId);
  if (approval && ctx.hooks?.onApprovalDecision) {
    await ctx.hooks.onApprovalDecision(ctx, approval.approvalId, approval.choice, employee);
    return {
      handled: true,
      caseId: null,
      classification: { intent: 'other', option: null, confidence: 1, source: 'rules' },
      action: 'logged',
    };
  }

  const followUp = parseFollowUpSelectionId(inbound.selectionId);
  if (followUp && ctx.hooks?.onFollowUpResponse) {
    const followUpCase = await ctx.tx.query.cases.findFirst({
      where: and(eq(cases.id, followUp.caseId), eq(cases.employeeId, employee.id)),
    });
    if (followUpCase) {
      await ctx.tx.update(messages).set({ caseId: followUpCase.id }).where(eq(messages.id, inboundRow.id));
      await ctx.hooks.onFollowUpResponse(ctx, followUpCase, employee, followUp.choice);
      return {
        handled: true,
        caseId: followUpCase.id,
        classification: { intent: 'other', option: null, confidence: 1, source: 'rules' },
        action: 'answered',
      };
    }
  }

  const offer = parseOfferSelectionId(inbound.selectionId);
  if (offer && ctx.hooks?.onOfferResponse) {
    const offerCase = await ctx.tx.query.cases.findFirst({
      where: and(eq(cases.id, offer.caseId), eq(cases.employeeId, employee.id)),
    });
    if (offerCase) {
      await ctx.tx.update(messages).set({ caseId: offerCase.id }).where(eq(messages.id, inboundRow.id));
      await ctx.hooks.onOfferResponse(ctx, offerCase, employee, offer.choice);
      return {
        handled: true,
        caseId: offerCase.id,
        classification: { intent: 'other', option: null, confidence: 1, source: 'rules' },
        action: 'answered',
      };
    }
  }

  const target = await resolveCase(ctx, employee.id, inbound, conversation.activeCaseId);
  if (target.caseRow) {
    await ctx.tx.update(messages).set({ caseId: target.caseRow.id }).where(eq(messages.id, inboundRow.id));
  }

  // A tapped option names its case and its answer, so no model is involved.
  if (target.option && target.caseRow) {
    const classification: Classification = {
      intent: 'was_absent',
      option: target.option,
      confidence: 1,
      source: 'rules',
    };
    const outcome = await applyAnswer(ctx, target.caseRow, employee, target.option);
    if (!outcome.offered) await chainNextPending(ctx, employee, target.caseRow.id);
    return { handled: true, caseId: target.caseRow.id, classification, action: 'answered' };
  }

  const pending = await pendingCases(ctx, employee.id);
  const classification = await classifyReply(inbound.text ?? '', {
    dateLabel: target.caseRow ? dateLabel(target.caseRow.attDate, target.caseRow.meaning as Meaning) : undefined,
    pendingDateLabels: pending.map((c) => dateLabel(c.attDate, c.meaning as Meaning)),
    language: employee.language ?? ctx.settings.defaultLanguage,
    tenantModelOverride: ctx.settings.modelOverrides?.classify_reply,
  });

  if (classification.source === 'model') {
    await ctx.tx.insert(aiDecisions).values({
      tenantId: ctx.tenantId,
      caseId: target.caseRow?.id ?? null,
      messageId: inboundRow.id,
      task: 'classify_reply',
      provider: classification.model?.provider ?? 'unknown',
      model: classification.model?.model ?? 'unknown',
      inputText: inbound.text ?? '',
      output: classification as unknown as Record<string, unknown>,
      confidence: String(classification.confidence),
      fallbackUsed: classification.model?.fallbackUsed ?? false,
      latencyMs: classification.model?.latencyMs,
    });
  }

  if (classification.intent === 'opt_out') {
    await ctx.tx.update(employees).set({ whatsappOptOut: true }).where(eq(employees.id, employee.id));
    await ctx.tx.insert(consentEvents).values({
      tenantId: ctx.tenantId,
      employeeId: employee.id,
      kind: 'whatsapp_opt_out',
      source: 'employee_message',
      detail: inbound.text ?? undefined,
    });
    // Opt-out is honoured immediately, but this one confirmation is still sent.
    await sendText(ctx, { ...employee, whatsappOptOut: false }, optOutConfirmation);
    await markCasesNeedHr(ctx, employee.id, 'Employee opted out of messages');
    return { handled: true, caseId: null, classification, action: 'opted_out' };
  }

  if (!target.caseRow) {
    // Nothing open for this person: log it and let HR see it.
    return { handled: true, caseId: null, classification, action: 'logged' };
  }

  if (classification.option) {
    const outcome = await applyAnswer(ctx, target.caseRow, employee, classification.option, classification);
    if (!outcome.offered) await chainNextPending(ctx, employee, target.caseRow.id);
    return { handled: true, caseId: target.caseRow.id, classification, action: 'answered' };
  }

  if (classification.intent === 'needs_help' || classification.intent === 'question') {
    // Policy answering arrives with the policy pack; until then a question is a
    // handover, which is the honest behaviour rather than an invented answer.
    await ctx.tx
      .update(cases)
      .set({
        status: 'needs_hr',
        needsHrReason:
          classification.intent === 'question' ? `Asked: ${classification.question ?? inbound.text}` : 'Asked for help',
        replyText: inbound.text,
        aiUsed: classification.source === 'model',
        updatedAt: now(ctx),
      })
      .where(eq(cases.id, target.caseRow.id));
    await sendText(ctx, employee, handedToHrMessage, target.caseRow.id);
    return { handled: true, caseId: target.caseRow.id, classification, action: 'handed_to_hr' };
  }

  // Unclear: ask once more with the options attached, then it is HR's.
  const alreadyClarified = Boolean((target.caseRow.context as Record<string, unknown>)?.clarifiedAt);
  if (alreadyClarified) {
    await ctx.tx
      .update(cases)
      .set({
        status: 'needs_hr',
        needsHrReason: 'Reply could not be understood twice',
        replyText: inbound.text,
        aiUsed: true,
        updatedAt: now(ctx),
      })
      .where(eq(cases.id, target.caseRow.id));
    await sendText(ctx, employee, handedToHrMessage, target.caseRow.id);
    return { handled: true, caseId: target.caseRow.id, classification, action: 'handed_to_hr' };
  }

  const label = dateLabel(target.caseRow.attDate, target.caseRow.meaning as Meaning);
  await askCase(ctx, target.caseRow, employee, { remaining: pending.length, body: clarifyMessage(label) });
  await ctx.tx
    .update(cases)
    .set({
      replyText: inbound.text,
      aiUsed: classification.source === 'model',
      context: { ...(target.caseRow.context as object), clarifiedAt: now(ctx).toISOString() },
      updatedAt: now(ctx),
    })
    .where(eq(cases.id, target.caseRow.id));
  return { handled: true, caseId: target.caseRow.id, classification, action: 'clarified' };
}

/**
 * Works out which date a reply is about.
 *
 * A tap carries its case in the payload, so it is never ambiguous even with a
 * dozen look-alike questions outstanding. A quoted reply names the message.
 * Typed text falls back to the date the agent asked about most recently, and
 * then to the oldest unanswered one.
 */
async function resolveCase(
  ctx: EngineContext,
  employeeId: string,
  inbound: InboundMessage,
  activeCaseId: string | null,
): Promise<{ caseRow: CaseRow | null; option: OptionNumber | null }> {
  const selection = parseSelectionId(inbound.selectionId);
  if (selection) {
    const row = await ctx.tx.query.cases.findFirst({
      where: and(eq(cases.id, selection.caseId), eq(cases.employeeId, employeeId)),
    });
    if (row) return { caseRow: row, option: selection.option };
  }

  if (inbound.replyToProviderId) {
    const quoted = await ctx.tx.query.messages.findFirst({
      where: eq(messages.providerMessageId, inbound.replyToProviderId),
    });
    if (quoted?.caseId) {
      const row = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, quoted.caseId) });
      if (row) return { caseRow: row, option: null };
    }
  }

  if (activeCaseId) {
    const row = await ctx.tx.query.cases.findFirst({
      where: and(eq(cases.id, activeCaseId), inArray(cases.status, [...UNANSWERED])),
    });
    if (row) return { caseRow: row, option: null };
  }

  const [oldest] = await ctx.tx
    .select()
    .from(cases)
    .where(and(eq(cases.employeeId, employeeId), inArray(cases.status, [...UNANSWERED])))
    .orderBy(asc(cases.attDate))
    .limit(1);
  return { caseRow: oldest ?? null, option: null };
}

/** Records the answer, sends the matching guidance, and starts the escalation clocks. */
export async function applyAnswer(
  ctx: EngineContext,
  caseRow: CaseRow,
  employee: EmployeeRow,
  option: OptionNumber,
  classification?: Classification,
) {
  const at = now(ctx);
  const label = dateLabel(caseRow.attDate, caseRow.meaning as Meaning);
  const followUpDue = new Date(at.getTime() + ctx.settings.followUpAfterDays * 86_400_000);
  const callDue = new Date(at.getTime() + ctx.settings.callAfterDays * 86_400_000);

  await ctx.tx
    .update(cases)
    .set({
      status: 'answered',
      answeredAt: at,
      replyOption: option,
      replyIntent: classification?.intent as CaseRow['replyIntent'],
      replyText: classification ? (classification.reason ?? null) : null,
      aiUsed: classification?.source === 'model',
      followUpDueAt: followUpDue,
      callDueAt: callDue,
      error: null,
      updatedAt: at,
    })
    .where(eq(cases.id, caseRow.id));

  await sendText(ctx, employee, systemReply(option, label), caseRow.id);

  // With actions enabled, the agent now offers to do the work. While that offer
  // is open the backlog stays quiet, so the two conversations never overlap.
  if (ctx.hooks?.onAnswered) {
    const updated = await ctx.tx.query.cases.findFirst({ where: eq(cases.id, caseRow.id) });
    return { offered: await ctx.hooks.onAnswered(ctx, updated ?? caseRow, employee, option) };
  }
  return { offered: false };
}

async function markCasesNeedHr(ctx: EngineContext, employeeId: string, reason: string) {
  await ctx.tx
    .update(cases)
    .set({ status: 'needs_hr', needsHrReason: reason, updatedAt: now(ctx) })
    .where(and(eq(cases.employeeId, employeeId), inArray(cases.status, [...UNANSWERED])));
}

/** Delivery receipts: sent → delivered → read, or failed with the provider's reason. */
export async function applyDeliveryUpdate(
  tx: Db,
  tenantId: string,
  update: { providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; error?: string; at: Date },
) {
  const message = await tx.query.messages.findFirst({
    where: and(eq(messages.tenantId, tenantId), eq(messages.providerMessageId, update.providerMessageId)),
  });
  if (!message) return { matched: false };

  await tx
    .update(messages)
    .set({
      status: update.status,
      error: update.error,
      deliveredAt: update.status === 'delivered' ? update.at : message.deliveredAt,
      readAt: update.status === 'read' ? update.at : message.readAt,
    })
    .where(eq(messages.id, message.id));

  if (!message.caseId) return { matched: true };

  const rank: Record<string, number> = { queued: 0, asked: 1, delivered: 2, read: 3 };
  const caseRow = await tx.query.cases.findFirst({ where: eq(cases.id, message.caseId) });
  if (!caseRow) return { matched: true };

  if (update.status === 'failed') {
    if (caseRow.status in rank) {
      await tx
        .update(cases)
        .set({ status: 'failed', error: update.error ?? 'Delivery failed', updatedAt: update.at })
        .where(eq(cases.id, caseRow.id));
    }
    return { matched: true };
  }

  const nextRank = rank[update.status];
  const currentRank = rank[caseRow.status];
  if (nextRank !== undefined && currentRank !== undefined && nextRank > currentRank) {
    await tx
      .update(cases)
      .set({ status: update.status as CaseRow['status'], updatedAt: update.at })
      .where(eq(cases.id, caseRow.id));
  }
  return { matched: true };
}
