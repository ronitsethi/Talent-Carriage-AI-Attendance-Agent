import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { withPlatformScope, withTenant, type Db } from '@/db';
import { coePeople, coeTeams, employees, queries, tenants, ticketMessages } from '@/db/schema';
import type { DeliveryUpdate, InboundMessage, Outbound } from '@/lib/channels/types';
import { buildContext } from '@/lib/runtime';
import { queueAssignmentWork, ticketLabel } from '@/lib/tickets';

/**
 * Tickets on WhatsApp: telling the COE person a ticket is theirs, warning them
 * at 36 hours, moving it to the LT person at 48, and closing it when they write
 * back.
 *
 * Messages to them are started by us, often days after they last wrote, so they
 * go as Meta-approved templates - the three named here, which must be approved
 * on the WhatsApp Business account before anything reaches anybody. Until then
 * a send fails, and the failure is logged against the ticket where HR can see it.
 * A reply to them - the thanks for closing, or the list when it is not clear
 * which ticket they mean - is free text, because they have just written.
 */

export const TICKET_TEMPLATES = {
  assigned: 'coe_ticket_assigned',
  reminder: 'coe_ticket_reminder',
  escalated: 'coe_ticket_escalated',
} as const;
const TEMPLATE_LANGUAGE = 'en';
/** The payload of a template's Resolved button: which ticket it closes. */
const RESOLVE = 'tkt:';

type Query = typeof queries.$inferSelect;
type Person = typeof coePeople.$inferSelect;

/**
 * A template variable. WhatsApp refuses one with a line break, a tab or a long
 * run of spaces, and the whole body is capped at 1,024 characters.
 */
function variable(text: string | null | undefined, max = 120): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim() || '-';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' } as Record<string, string>;

/** Everything a message about a ticket names: the ticket, the employee, their company. */
async function ticketFacts(tx: Db, query: Query) {
  const employee = await tx.query.employees.findFirst({ where: eq(employees.id, query.employeeId) });
  const company = await tx.query.tenants.findFirst({ where: eq(tenants.id, query.tenantId), columns: { name: true } });
  return {
    label: ticketLabel(query.ticketNo),
    employee: employee ? `${employee.fullName} (${employee.empCode})` : 'An employee',
    company: company?.name ?? 'their company',
    type: query.queryTypeName ?? 'Unclassified',
    priority: PRIORITY[query.priority ?? 'medium'] ?? 'Medium',
    description: query.problemDescription ?? 'No description was written.',
  };
}

/** Sends through the employee's company's WhatsApp line, and logs it against the ticket either way. */
async function send(query: Query, person: Person, kind: string, message: Outbound): Promise<boolean> {
  let providerMessageId: string | null = null;
  let status = 'sent';
  let error: string | null = null;
  try {
    const result = await withTenant(query.tenantId, async (tx) => (await buildContext(tx, query.tenantId)).channel.send(message));
    providerMessageId = result.providerMessageId;
    if (result.simulated) status = 'simulated';
  } catch (problem) {
    status = 'failed';
    error = (problem as Error).message.slice(0, 500);
  }
  const body = message.kind === 'template' ? message.preview : message.kind === 'text' ? message.body : 'body' in message ? message.body : '';
  await withPlatformScope((tx) =>
    tx.insert(ticketMessages).values({ queryId: query.id, personId: person.id, direction: 'outbound', kind, body, providerMessageId, status, error }),
  );
  if (error) console.error(`[tickets] ${kind} for ${ticketLabel(query.ticketNo)} to ${person.fullName} failed: ${error}`);
  return !error;
}

function template(person: Person, name: string, variables: string[], preview: string, queryId: string): Outbound {
  return {
    kind: 'template',
    to: person.mobileE164,
    templateName: name,
    language: TEMPLATE_LANGUAGE,
    variables,
    buttonPayloads: [`${RESOLVE}${queryId}`],
    preview,
  };
}

/** Loads a ticket that is still open and still with the person assigned at `assignedAt`; null otherwise. */
async function stillWith(tx: Db, queryId: string, assignedAt: string | undefined) {
  const query = await tx.query.queries.findFirst({ where: eq(queries.id, queryId) });
  if (!query || query.ticketStatus !== 'open' || !query.assignedPersonId) return null;
  if (assignedAt && query.assignedAt?.toISOString() !== assignedAt) return null;
  const person = await tx.query.coePeople.findFirst({ where: eq(coePeople.id, query.assignedPersonId) });
  return person ? { query, person } : null;
}

/**
 * Tells the person a ticket is now theirs. An LT person who has just been handed
 * it by escalation is told why; anybody else gets the ticket itself.
 */
export async function notifyAssignee(queryId: string, assignedAt?: string): Promise<{ sent: boolean } | { skipped: string }> {
  const found = await withPlatformScope((tx) => stillWith(tx, queryId, assignedAt));
  if (!found) return { skipped: 'no longer open with that person' };
  const { query, person } = found;
  const facts = await withPlatformScope((tx) => ticketFacts(tx, query));

  if (query.ltTransferredAt && query.ltPersonId === person.id) {
    const before = await withPlatformScope(async (tx) => {
      const [last] = await tx
        .select({ name: coePeople.fullName })
        .from(ticketMessages)
        .innerJoin(coePeople, eq(coePeople.id, ticketMessages.personId))
        .where(and(eq(ticketMessages.queryId, query.id), eq(ticketMessages.kind, 'assigned')))
        .orderBy(desc(ticketMessages.createdAt))
        .limit(1);
      return last?.name ?? 'the COE team';
    });
    const variables = [facts.label, facts.employee, facts.company, before, facts.type, facts.priority, facts.description];
    const preview =
      `Ticket ${facts.label} for ${facts.employee}, ${facts.company}, was not resolved by ${before} within 48 hours and has been escalated to you.\n\n` +
      `Query type: ${facts.type}\nPriority: ${facts.priority}\n\n${facts.description}\n\nReply to this message once it is resolved.`;
    return { sent: await send(query, person, 'escalated', template(person, TICKET_TEMPLATES.escalated, variables.map((v) => variable(v, 600)), preview, query.id)) };
  }

  const variables = [facts.label, facts.employee, facts.company, facts.type, facts.priority, facts.description];
  const preview =
    `New ticket ${facts.label} has been assigned to you.\n\nEmployee: ${facts.employee}, ${facts.company}\n` +
    `Query type: ${facts.type}\nPriority: ${facts.priority}\n\n${facts.description}\n\nReply to this message once it is resolved.`;
  return { sent: await send(query, person, 'assigned', template(person, TICKET_TEMPLATES.assigned, variables.map((v) => variable(v, 600)), preview, query.id)) };
}

/** At 36 hours: still not resolved, so the member is told it moves to the LT person in 12. */
export async function remindAssignee(queryId: string, assignedAt: string): Promise<{ sent: boolean } | { skipped: string }> {
  const found = await withPlatformScope((tx) => stillWith(tx, queryId, assignedAt));
  if (!found) return { skipped: 'resolved or reassigned since' };
  const { query, person } = found;
  if (query.ltTransferredAt || query.remindedAt) return { skipped: 'already with the LT person, or reminded' };
  const lt = await withPlatformScope((tx) => ltFor(tx, query));
  const facts = await withPlatformScope((tx) => ticketFacts(tx, query));
  const ltName = lt?.fullName ?? 'the LT person';
  const preview =
    `You have not resolved ticket ${facts.label} for ${facts.employee}, ${facts.company}, yet. If it is not resolved within the next 12 hours, ` +
    `it will be escalated to the LT person ${ltName}.\n\nReply to the ticket message once it is resolved.`;
  const sent = await send(query, person, 'reminder', template(person, TICKET_TEMPLATES.reminder, [facts.label, facts.employee, facts.company, ltName].map((v) => variable(v)), preview, query.id));
  await withPlatformScope((tx) => tx.update(queries).set({ remindedAt: new Date() }).where(eq(queries.id, query.id)));
  return { sent };
}

/** The LT person of the team the ticket is with - or, failing that, of the team its query type belongs to. */
async function ltFor(tx: Db, query: Query): Promise<Person | null> {
  const team = query.assignedTeamId
    ? await tx.query.coeTeams.findFirst({ where: eq(coeTeams.id, query.assignedTeamId) })
    : query.coeCode
      ? await tx.query.coeTeams.findFirst({ where: eq(coeTeams.code, query.coeCode) })
      : null;
  if (!team?.ltPersonId) return null;
  return (await tx.query.coePeople.findFirst({ where: eq(coePeople.id, team.ltPersonId) })) ?? null;
}

/**
 * At 48 hours: still not resolved, so the ticket moves to the LT person, who
 * is told. A team with no LT person cannot escalate; that is logged where HR
 * sees it, and the ticket stays where it is.
 */
export async function escalateToLt(queryId: string, assignedAt: string): Promise<{ escalatedTo: string } | { skipped: string }> {
  const moved = await withPlatformScope(async (tx) => {
    const found = await stillWith(tx, queryId, assignedAt);
    if (!found) return { skipped: 'resolved or reassigned since' } as const;
    const { query, person } = found;
    if (query.ltTransferredAt) return { skipped: 'already with the LT person' } as const;
    const lt = await ltFor(tx, query);
    if (!lt || lt.id === person.id) {
      await tx.insert(ticketMessages).values({
        queryId,
        personId: person.id,
        direction: 'outbound',
        kind: 'escalated',
        status: 'failed',
        error: lt ? 'The assignee is the LT person, so there is nobody to escalate to.' : 'The team has no LT person, so it could not be escalated.',
      });
      return { skipped: 'no LT person to escalate to' } as const;
    }
    const at = new Date();
    await tx
      .update(queries)
      .set({ assignedPersonId: lt.id, assignedAt: at, ltTransferredAt: at, ltPersonId: lt.id, assignmentMark: null })
      .where(eq(queries.id, queryId));
    // Tell the LT person. The clocks are not started again: the LT person is the last stop.
    await queueAssignmentWork(tx, query.tenantId, queryId, at, false);
    return { escalatedTo: lt.fullName } as const;
  });
  return moved;
}

/* ------------------------------------------------------------------ *
 * What COE people send back
 * ------------------------------------------------------------------ */

/**
 * A message from a COE person about their tickets. Which ticket it is about is
 * the one whose Resolved button they tapped, else the one whose message they
 * replied to, else - when they hold just one open ticket - that one. Holding
 * several and saying none of that, they are asked which.
 *
 * Returns false when the sender is no COE person, or one holding no open ticket
 * and not answering a ticket message: an employee who is also on a COE team
 * still gets to ask the agent things.
 */
export async function handleTicketReply(message: InboundMessage): Promise<boolean> {
  const person = await withPlatformScope((tx) => tx.query.coePeople.findFirst({ where: eq(coePeople.mobileE164, message.from) }));
  if (!person) return false;

  const ticketId = await withPlatformScope(async (tx) => {
    if (message.selectionId?.startsWith(RESOLVE)) return message.selectionId.slice(RESOLVE.length);
    if (message.replyToProviderId) {
      const [quoted] = await tx
        .select({ queryId: ticketMessages.queryId })
        .from(ticketMessages)
        .where(eq(ticketMessages.providerMessageId, message.replyToProviderId))
        .limit(1);
      if (quoted) return quoted.queryId;
    }
    return null;
  });

  const open = await withPlatformScope((tx) =>
    tx
      .select()
      .from(queries)
      .where(and(eq(queries.assignedPersonId, person.id), eq(queries.ticketStatus, 'open')))
      .orderBy(asc(queries.ticketNo)),
  );
  if (!ticketId && !open.length) return false;

  const text = message.selectionTitle ?? message.text ?? '';
  const log = (queryId: string) =>
    withPlatformScope((tx) =>
      tx
        .insert(ticketMessages)
        .values({ queryId, personId: person.id, direction: 'inbound', kind: 'reply', body: text, providerMessageId: message.providerMessageId, status: 'received' })
        .onConflictDoNothing(),
    );

  if (ticketId) {
    const ticket = await withPlatformScope((tx) => tx.query.queries.findFirst({ where: eq(queries.id, ticketId) }));
    if (!ticket?.ticketStatus) return false;
    await log(ticket.id);
    if (ticket.ticketStatus === 'resolved') {
      await send(ticket, person, 'resolved', { kind: 'text', to: person.mobileE164, body: `${ticketLabel(ticket.ticketNo)} is already marked resolved. Thank you.` });
      return true;
    }
    if (ticket.assignedPersonId !== person.id) {
      const holder = ticket.assignedPersonId
        ? await withPlatformScope((tx) => tx.query.coePeople.findFirst({ where: eq(coePeople.id, ticket.assignedPersonId!) }))
        : null;
      await send(ticket, person, 'moved', {
        kind: 'text',
        to: person.mobileE164,
        body: `${ticketLabel(ticket.ticketNo)} is now with ${holder?.fullName ?? 'somebody else'}, so it was not closed from here.`,
      });
      return true;
    }
    await resolve(ticket, person);
    return true;
  }

  if (open.length === 1) {
    await log(open[0]!.id);
    await resolve(open[0]!, person);
    return true;
  }

  // Several open and no way to tell which: ask, with the open ones to pick from.
  await log(open[0]!.id);
  const facts = await withPlatformScope(async (tx) => {
    const people = await tx
      .select({ id: employees.id, name: employees.fullName })
      .from(employees)
      .where(inArray(employees.id, open.map((q) => q.employeeId)));
    return new Map(people.map((p) => [p.id, p.name]));
  });
  await send(open[0]!, person, 'which', {
    kind: 'list',
    to: person.mobileE164,
    body: `You have ${open.length} open tickets. Which one is resolved?`,
    buttonLabel: 'Choose the ticket',
    rows: open.slice(0, 10).map((q) => ({
      id: `${RESOLVE}${q.id}`,
      title: ticketLabel(q.ticketNo),
      description: variable(`${facts.get(q.employeeId) ?? 'Employee'} · ${q.queryTypeName ?? 'Unclassified'}`, 72),
    })),
  });
  return true;
}

async function resolve(ticket: Query, person: Person) {
  await withPlatformScope((tx) =>
    tx.update(queries).set({ ticketStatus: 'resolved', resolvedAt: new Date() }).where(and(eq(queries.id, ticket.id), eq(queries.ticketStatus, 'open'))),
  );
  await send(ticket, person, 'resolved', {
    kind: 'text',
    to: person.mobileE164,
    body: `Thank you - ${ticketLabel(ticket.ticketNo)} is marked resolved.`,
  });
}

/**
 * Delivery receipts for ticket messages. Returns the ids it recognised, so the
 * rest are left to the customer's own messages.
 */
export async function applyTicketDeliveries(updates: DeliveryUpdate[]): Promise<Set<string>> {
  if (!updates.length) return new Set();
  return withPlatformScope(async (tx) => {
    const known = await tx
      .select({ id: ticketMessages.providerMessageId })
      .from(ticketMessages)
      .where(inArray(ticketMessages.providerMessageId, updates.map((u) => u.providerMessageId)));
    const ids = new Set(known.map((k) => k.id!));
    for (const update of updates) {
      if (!ids.has(update.providerMessageId)) continue;
      await tx
        .update(ticketMessages)
        .set({ status: update.status, ...(update.error ? { error: update.error.slice(0, 500) } : {}) })
        .where(eq(ticketMessages.providerMessageId, update.providerMessageId));
    }
    return ids;
  });
}

/** A ticket's WhatsApp history, oldest first, for the query page. */
export async function ticketActivity(queryId: string) {
  return withPlatformScope((tx) =>
    tx
      .select({
        id: ticketMessages.id,
        direction: ticketMessages.direction,
        kind: ticketMessages.kind,
        status: ticketMessages.status,
        error: ticketMessages.error,
        at: ticketMessages.createdAt,
        person: coePeople.fullName,
      })
      .from(ticketMessages)
      .leftJoin(coePeople, eq(coePeople.id, ticketMessages.personId))
      .where(eq(ticketMessages.queryId, queryId))
      .orderBy(asc(ticketMessages.createdAt)),
  );
}
