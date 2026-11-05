import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { withPlatformScope, type Db } from '@/db';
import { coeMemberClients, coePeople, coeTeamMembers, coeTeams, employees, queries } from '@/db/schema';
import { ask, queryConversation, transcriptText } from '@/lib/conversation/summary';
import { QUERY_QUIET_MS } from '@/lib/conversation/queries';
import { enqueue } from '@/lib/jobs/queue';
import { listQueryTypes, type QueryType } from '@/lib/query-types';
import { withCostScope } from '@/lib/costs/record';

/**
 * Tickets: a query the agent could not settle, handed to a COE team member.
 *
 * Once a conversation is over the model reads it and decides whether anything
 * is left for a person to do. If so it writes the ticket - which query type it
 * is, how urgent, and the problem in a few sentences - and the ticket goes to
 * the least busy member who looks after the employee's company.
 *
 * A query with nothing left to do but still about something real - a question
 * the agent answered - is not a ticket. It is written up the same way and sent
 * to the members of its query type's team who look after the company, for
 * their information.
 *
 * Everything here runs in platform scope: COE people work across customers, so
 * how busy somebody is counts their tickets from every customer, not only the
 * one this query belongs to.
 */

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/** How long after a ticket is closed the employee can say it is still not right, and have it raised again. */
export const FOLLOW_UP_DAYS = 7;

/** How long a member has before they are warned, and before the ticket moves to the LT person. */
export const REMIND_AFTER_MS = 36 * 3600_000;
export const ESCALATE_AFTER_MS = 48 * 3600_000;

/** What a WhatsApp message calls a ticket: TKT-00012. */
export const ticketLabel = (no: number | null) => (no ? `TKT-${String(no).padStart(5, '0')}` : 'TKT-?');
export type Priority = (typeof PRIORITIES)[number];
export type AssignmentMark = 'other_team' | 'no_cover' | 'no_type';

export type Candidate = { personId: string; teamId: string };
export type Assignment = { personId: string | null; teamId: string | null; mark: AssignmentMark | null };

/**
 * The member with the fewest open tickets; on a tie, whoever comes first. The
 * candidates arrive in the order that breaks ties - a team's own list order.
 */
export function leastBusy(candidates: Candidate[], open: Map<string, number>): Candidate | null {
  let best: Candidate | null = null;
  let fewest = Infinity;
  for (const candidate of candidates) {
    const load = open.get(candidate.personId) ?? 0;
    if (load < fewest) {
      best = candidate;
      fewest = load;
    }
  }
  return best;
}

/** How many open tickets each of these people holds, across every customer. */
async function openTickets(tx: Db, personIds: string[]): Promise<Map<string, number>> {
  if (!personIds.length) return new Map();
  const rows = await tx
    .select({ personId: queries.assignedPersonId, open: sql<number>`count(*)::int` })
    .from(queries)
    .where(and(inArray(queries.assignedPersonId, personIds), eq(queries.ticketStatus, 'open')))
    .groupBy(queries.assignedPersonId);
  return new Map(rows.map((row) => [row.personId!, row.open]));
}

/**
 * Who a ticket goes to. The query type's team first: among its members who look
 * after this company, the least busy. When none of them does - or no team has
 * that code - any member of any team who looks after the company takes it, and
 * the ticket is marked so. When nobody looks after the company, it waits for HR.
 */
export async function chooseAssignee(tx: Db, tenantId: string, coeCode: string | null): Promise<Assignment> {
  if (!coeCode) return { personId: null, teamId: null, mark: 'no_type' };

  const covering = await tx
    .select({ personId: coeMemberClients.personId, teamId: coeMemberClients.teamId, code: coeTeams.code })
    .from(coeMemberClients)
    .innerJoin(coeTeams, eq(coeTeams.id, coeMemberClients.teamId))
    .innerJoin(
      coeTeamMembers,
      and(eq(coeTeamMembers.teamId, coeMemberClients.teamId), eq(coeTeamMembers.personId, coeMemberClients.personId)),
    )
    .where(eq(coeMemberClients.tenantId, tenantId))
    .orderBy(asc(coeTeams.code), asc(coeTeamMembers.position));
  if (!covering.length) return { personId: null, teamId: null, mark: 'no_cover' };

  const own = covering.filter((c) => c.code === coeCode);
  // One person on two other teams is still one person: the first place they appear decides their turn.
  const pool = own.length ? own : [...new Map(covering.map((c) => [c.personId, c])).values()];
  const picked = leastBusy(pool, await openTickets(tx, pool.map((c) => c.personId)))!;
  return { personId: picked.personId, teamId: picked.teamId, mark: own.length ? null : 'other_team' };
}

const TICKET_PROMPT = `You file tickets for an HR helpdesk. You read a conversation between an employee and an HR assistant - a phone call or a WhatsApp chat, in English, Hindi or a mix - and decide whether a person at HR still has something to do.

needs_ticket is true when the employee raised a request or problem the assistant did not settle in the conversation: it said it would log or raise a ticket, or that HR would come back to them, or the request needs somebody to act - correct their data, process or approve something, investigate a payment or a record. It is false when every question was fully answered, or the employee only greeted, tested or hung up.

When a ticket is needed:
- query_type: the number of the one query type below that best fits the employee's main request. Use 0 only when truly none fits.
- priority: "urgent" for a grievance, harassment, safety or distress; "high" when pay is missing or wrong, or something stops them working or being paid this month; "low" for a general question with nothing at stake; otherwise "medium".
- description: two to four plain English sentences, in the third person and using the employee's name, saying what the problem is and every specific detail they gave - dates, months, amounts, which record or field, what the system shows against what is right. Use only what was said; never guess.

When no ticket is needed but the employee still asked or told something real - about their pay, leave, attendance, a policy, a document - it is shared with the COE team for their information:
- query_type: the number of the one query type below that best fits it, or 0 when truly none fits.
- priority: "low".
- description: two to four plain English sentences, in the third person and using the employee's name, saying what they asked, with every specific detail they gave, and what they were told. Use only what was said; never guess.

When the employee only greeted, tested or hung up, give query_type 0, priority "low" and an empty description.

RECENTLY CLOSED TICKETS lists this employee's tickets closed in the last week, if any. When the employee says the problem in one of them is still not right - not fixed, still wrong, still short, still waiting - it is a follow-up: needs_ticket is true, follows_ticket is that ticket's number in the list, and the description says what the original problem was and what the employee says is still not right. A new problem, even on the same subject (another month, another document), is not a follow-up. A thank-you or acknowledgement of a closed ticket needs nothing. When it is not a follow-up, follows_ticket is 0.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['needs_ticket', 'query_type', 'priority', 'description', 'follows_ticket'],
  properties: {
    needs_ticket: { type: 'boolean' },
    follows_ticket: { type: 'integer' },
    query_type: { type: 'integer' },
    priority: { type: 'string', enum: [...PRIORITIES] },
    description: { type: 'string' },
  },
};

const cut = (text: string | null, length: number) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
};

/** The sheet as the model reads it: one numbered line per type, its words and an example. */
export function describeTypes(types: QueryType[]): string {
  return types
    .map((type, index) =>
      [
        `${index + 1}. ${type.name} [${type.coeCode}]`,
        type.description ? ` - ${cut(type.description, 260)}` : '',
        type.keywords ? ` Keywords: ${cut(type.keywords, 220)}.` : '',
        type.triggerCriteria ? ` When: ${cut(type.triggerCriteria, 220)}` : '',
      ].join(''),
    )
    .join('\n');
}

type Verdict = { needs_ticket: boolean; query_type: number; priority: Priority; description: string; follows_ticket?: number };

/** A ticket of the same employee's closed in the last week, as the model is shown it. */
export type ClosedTicket = { id: string; label: string; type: string | null; resolvedAt: Date; description: string | null };

export type TicketOutcome =
  | { done: 'no_conversation' | 'already_raised' | 'already_informed' | 'not_needed' | 'missing' }
  | { done: 'informed'; queryTypeName: string; people: number }
  | { done: 'later'; at: Date }
  | { done: 'raised'; queryTypeName: string | null; personId: string | null; mark: AssignmentMark | null; follows: string | null };

/**
 * Reads a finished query and raises its ticket when one is needed. A chat still
 * going - something said in the last half hour - is left for later, and the
 * caller is told when to look again.
 */
export async function raiseTicket(queryId: string, now = new Date(), decide: typeof askModel = askModel): Promise<TicketOutcome> {
  return withPlatformScope(async (tx) => {
    const query = await tx.query.queries.findFirst({ where: eq(queries.id, queryId) });
    if (!query) return { done: 'missing' };
    if (query.ticketStatus) return { done: 'already_raised' };
    if (query.informedAt) return { done: 'already_informed' };
    if (query.channel === 'whatsapp') {
      const quietAt = new Date(query.lastActivityAt.getTime() + QUERY_QUIET_MS);
      if (quietAt > now) return { done: 'later', at: quietAt };
    } else if (!query.endedAt) {
      return { done: 'later', at: new Date(now.getTime() + QUERY_QUIET_MS) };
    }

    const lines = await queryConversation(tx, query);
    if (!lines.some((line) => line.role === 'employee')) return { done: 'no_conversation' };

    const employee = await tx.query.employees.findFirst({ where: eq(employees.id, query.employeeId) });
    const types = await listQueryTypes(tx);
    const closed = await recentlyClosed(tx, query);
    const verdict = await withCostScope({ tenantId: query.tenantId, queryId: query.id }, () =>
      decide(types, employee?.fullName ?? 'the employee', transcriptText(lines), query.channel === 'voice' ? 'call' : 'whatsapp', closed),
    );
    const earlierId = (verdict.follows_ticket ?? 0) >= 1 ? closed[verdict.follows_ticket! - 1]?.id ?? null : null;
    const earlier = earlierId ? await tx.query.queries.findFirst({ where: eq(queries.id, earlierId) }) : null;
    const type = verdict.query_type >= 1 ? types[verdict.query_type - 1] ?? null : null;
    if (!verdict.needs_ticket && !earlier) return informTeam(tx, query, type, verdict.description);

    // A follow-up keeps the earlier ticket's type when the model names none.
    const typeFields = type
      ? { queryTypeId: type.id, queryTypeName: type.name, coeCode: type.coeCode }
      : { queryTypeId: earlier?.queryTypeId ?? null, queryTypeName: earlier?.queryTypeName ?? null, coeCode: earlier?.coeCode ?? null };
    // The sheet is plain: a grievance is never anything but urgent, whatever the model thought.
    const priority: Priority = typeFields.queryTypeName && /grievance|complaint/i.test(typeFields.queryTypeName) ? 'urgent' : verdict.priority;
    const handover = earlier ? await sameHands(tx, earlier) : null;
    const assignment = handover?.assignment ?? (await chooseAssignee(tx, query.tenantId, typeFields.coeCode));
    const text = verdict.description.trim();
    const label = earlier ? ticketLabel(earlier.ticketNo) : null;
    const at = new Date();
    await tx
      .update(queries)
      .set({
        ticketStatus: 'open',
        ticketRaisedAt: at,
        ...typeFields,
        priority,
        problemDescription: label ? `Follow-up to ${label}. ${text || earlier?.problemDescription || ''}`.trim() : text || null,
        assignedPersonId: assignment.personId,
        assignedTeamId: assignment.teamId,
        assignedAt: assignment.personId ? at : null,
        assignmentMark: assignment.mark,
        followsQueryId: earlier?.id ?? null,
        // Back with the LT person it had reached: shown as transferred, and no clocks, as after an escalation.
        ...(handover?.withLt ? { ltTransferredAt: at, ltPersonId: assignment.personId } : {}),
        ticketNo: sql`nextval('ticket_no_seq')`,
      })
      .where(eq(queries.id, queryId));
    if (assignment.personId) await queueAssignmentWork(tx, query.tenantId, queryId, at, !handover?.withLt);
    // The employee is told it is logged, whoever it is with.
    await queueEmployeeNotice(tx, query.tenantId, queryId, 'raised');
    return { done: 'raised', queryTypeName: typeFields.queryTypeName, personId: assignment.personId, mark: assignment.mark, follows: label };
  });
}

/**
 * No ticket, but something real was asked: written on the query as a ticket's
 * type and description would be - with no ticket status - and the notice to the
 * query type's team queued. Nothing to share, or nobody to share it with, is
 * simply not needed.
 */
async function informTeam(tx: Db, query: typeof queries.$inferSelect, type: QueryType | null, description: string): Promise<TicketOutcome> {
  const text = description.trim();
  if (!text || !type) return { done: 'not_needed' };
  const people = await informRecipients(tx, query.tenantId, type.coeCode);
  if (!people.length) return { done: 'not_needed' };
  const at = new Date();
  await tx
    .update(queries)
    .set({ queryTypeId: type.id, queryTypeName: type.name, coeCode: type.coeCode, problemDescription: text, informedAt: at })
    .where(eq(queries.id, query.id));
  await enqueue('query_inform', { queryId: query.id }, { tenantId: query.tenantId, dedupeKey: `query-inform:${query.id}` }, tx);
  return { done: 'informed', queryTypeName: type.name, people: people.length };
}

/**
 * Who hears about a query that needed no ticket: every member of the query
 * type's team who looks after this company, in the team's own order. Unlike a
 * ticket there is no one to pick - it is for everybody's information - and no
 * other team stands in when nobody on that one looks after the company.
 */
export async function informRecipients(tx: Db, tenantId: string, coeCode: string) {
  const rows = await tx
    .select({ person: coePeople })
    .from(coeMemberClients)
    .innerJoin(coeTeams, eq(coeTeams.id, coeMemberClients.teamId))
    .innerJoin(
      coeTeamMembers,
      and(eq(coeTeamMembers.teamId, coeMemberClients.teamId), eq(coeTeamMembers.personId, coeMemberClients.personId)),
    )
    .innerJoin(coePeople, eq(coePeople.id, coeMemberClients.personId))
    .where(and(eq(coeMemberClients.tenantId, tenantId), eq(coeTeams.code, coeCode)))
    .orderBy(asc(coeTeamMembers.position));
  return [...new Map(rows.map((row) => [row.person.id, row.person])).values()];
}

async function askModel(
  types: QueryType[],
  employeeName: string,
  transcript: string,
  budget: 'call' | 'whatsapp',
  closed: ClosedTicket[] = [],
): Promise<Verdict> {
  const listed = types.length ? describeTypes(types) : '(No query types have been uploaded yet: use 0.)';
  const recent = closed.length ? describeClosed(closed) : '(None.)';
  return ask<Verdict>(
    TICKET_PROMPT,
    `QUERY TYPES\n${listed}\n\nRECENTLY CLOSED TICKETS\n${recent}\n\nEMPLOYEE: ${employeeName}\n\nCONVERSATION\n${transcript}`,
    SCHEMA,
    budget,
    600,
    'Deciding on a ticket',
  );
}

/** The closed tickets as the model reads them: one numbered line each. */
export function describeClosed(closed: ClosedTicket[]): string {
  return closed
    .map((ticket, index) => `${index + 1}. ${ticket.label} [${ticket.type ?? 'Unclassified'}], closed ${ticket.resolvedAt.toISOString().slice(0, 10)}: ${cut(ticket.description, 400) || 'no description'}`)
    .join('\n');
}

/**
 * The employee's tickets closed in the week before this query, newest first:
 * the ones they may be saying are still not right. A ticket closed after the
 * query began cannot be what it is about.
 */
async function recentlyClosed(tx: Db, query: typeof queries.$inferSelect): Promise<ClosedTicket[]> {
  const before = query.endedAt ?? query.lastActivityAt;
  const rows = await tx
    .select({ id: queries.id, no: queries.ticketNo, type: queries.queryTypeName, resolvedAt: queries.resolvedAt, description: queries.problemDescription })
    .from(queries)
    .where(
      and(
        eq(queries.employeeId, query.employeeId),
        ne(queries.id, query.id),
        eq(queries.ticketStatus, 'resolved'),
        isNotNull(queries.resolvedAt),
        gte(queries.resolvedAt, new Date(query.startedAt.getTime() - FOLLOW_UP_DAYS * 86_400_000)),
        lte(queries.resolvedAt, before),
      ),
    )
    .orderBy(desc(queries.resolvedAt))
    .limit(5);
  return rows.map((row) => ({ id: row.id, label: ticketLabel(row.no), type: row.type, resolvedAt: row.resolvedAt!, description: row.description }));
}

/**
 * A follow-up goes to whoever had the earlier ticket when it was closed - its LT
 * person, if it had got that far. Somebody since removed from the COE teams
 * cannot take it, and the usual choice is made instead.
 */
async function sameHands(tx: Db, earlier: typeof queries.$inferSelect): Promise<{ assignment: Assignment; withLt: boolean } | null> {
  if (!earlier.assignedPersonId) return null;
  const person = await tx.query.coePeople.findFirst({ where: eq(coePeople.id, earlier.assignedPersonId) });
  if (!person) return null;
  return {
    assignment: { personId: person.id, teamId: earlier.assignedTeamId, mark: null },
    withLt: Boolean(earlier.ltTransferredAt && earlier.ltPersonId === person.id),
  };
}

/**
 * What follows a ticket being given to somebody: the WhatsApp message telling
 * them, and the two clocks - the warning at 36 hours and the move to the LT
 * person at 48. Each carries the moment it was assigned, so a ticket reassigned
 * since does not act on the old clocks.
 */
export async function queueAssignmentWork(tx: Db, tenantId: string, queryId: string, assignedAt: Date, clocks = true) {
  const stamp = assignedAt.toISOString();
  const payload = { queryId, assignedAt: stamp };
  await enqueue('ticket_notify', payload, { tenantId, dedupeKey: `ticket-notify:${queryId}:${stamp}` }, tx);
  if (!clocks) return;
  await enqueue('ticket_reminder', payload, { tenantId, runAt: new Date(assignedAt.getTime() + REMIND_AFTER_MS), dedupeKey: `ticket-remind:${queryId}:${stamp}` }, tx);
  await enqueue('ticket_escalate', payload, { tenantId, runAt: new Date(assignedAt.getTime() + ESCALATE_AFTER_MS), dedupeKey: `ticket-escalate:${queryId}:${stamp}` }, tx);
}

/** The WhatsApp to the employee about their ticket: its number once raised, and when it is resolved. */
export async function queueEmployeeNotice(tx: Db, tenantId: string, queryId: string, event: 'raised' | 'resolved') {
  await enqueue('ticket_employee', { queryId, event }, { tenantId, dedupeKey: `ticket-employee:${queryId}:${event}` }, tx);
}

/**
 * Closes a ticket that is still open - from the COE person's WhatsApp or from
 * the portal - and queues the employee's notice. False when it was not open,
 * so nothing is said twice.
 */
export async function closeTicket(tx: Db, queryId: string, at = new Date()): Promise<boolean> {
  const [closed] = await tx
    .update(queries)
    .set({ ticketStatus: 'resolved', resolvedAt: at })
    .where(and(eq(queries.id, queryId), eq(queries.ticketStatus, 'open')))
    .returning({ tenantId: queries.tenantId });
  if (!closed) return false;
  await queueEmployeeNotice(tx, closed.tenantId, queryId, 'resolved');
  return true;
}

/** Queues the look at a query once it should be over: now for a call, half an hour after a chat goes quiet. */
export async function queueTicketCheck(tx: Db, tenantId: string, queryId: string, at: Date, retry = false) {
  await enqueue('query_ticket', { queryId }, { tenantId, runAt: at, dedupeKey: retry ? `ticket:${queryId}:${at.toISOString()}` : `ticket:${queryId}` }, tx);
}

/** The people a ticket can be given to by hand, team by team, for the query page. */
export async function assignablePeople(): Promise<{ id: string; name: string; code: string; teams: string[] }[]> {
  return withPlatformScope(async (tx) => {
    const rows = await tx
      .select({ id: coePeople.id, name: coePeople.fullName, code: coePeople.empCode, team: coeTeams.code })
      .from(coePeople)
      .leftJoin(coeTeamMembers, eq(coeTeamMembers.personId, coePeople.id))
      .leftJoin(coeTeams, eq(coeTeams.id, coeTeamMembers.teamId))
      .orderBy(asc(coePeople.fullName));
    const people = new Map<string, { id: string; name: string; code: string; teams: string[] }>();
    for (const row of rows) {
      const person = people.get(row.id) ?? { id: row.id, name: row.name, code: row.code ?? '', teams: [] };
      if (row.team && !person.teams.includes(row.team)) person.teams.push(row.team);
      people.set(row.id, person);
    }
    return [...people.values()];
  });
}

/** The LT person a ticket would move to: its assigned team's, else the team its query type belongs to. */
export async function ticketLtPerson(teamId: string | null, coeCode: string | null): Promise<string | null> {
  if (!teamId && !coeCode) return null;
  return withPlatformScope(async (tx) => {
    const team = await tx.query.coeTeams.findFirst({ where: teamId ? eq(coeTeams.id, teamId) : eq(coeTeams.code, coeCode!) });
    return team?.ltPersonId ?? null;
  });
}

/** Why a ticket's assignee is not the usual choice, in words for the query page. */
export function assignmentNote(mark: AssignmentMark | null, coeCode: string | null): string | null {
  if (mark === 'other_team') return `Nobody on ${coeCode ?? 'the query type’s team'} looks after this company, so another team’s member has it.`;
  if (mark === 'no_cover') return 'Nobody on any COE team looks after this company, so it is waiting to be assigned.';
  if (mark === 'no_type') return 'It matched no query type in the sheet, so it is waiting to be assigned.';
  return null;
}
