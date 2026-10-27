import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
 * Everything here runs in platform scope: COE people work across customers, so
 * how busy somebody is counts their tickets from every customer, not only the
 * one this query belongs to.
 */

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

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

When no ticket is needed, give query_type 0, priority "low" and an empty description.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['needs_ticket', 'query_type', 'priority', 'description'],
  properties: {
    needs_ticket: { type: 'boolean' },
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

type Verdict = { needs_ticket: boolean; query_type: number; priority: Priority; description: string };

export type TicketOutcome =
  | { done: 'no_conversation' | 'already_raised' | 'not_needed' | 'missing' }
  | { done: 'later'; at: Date }
  | { done: 'raised'; queryTypeName: string | null; personId: string | null; mark: AssignmentMark | null };

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
    const verdict = await withCostScope({ tenantId: query.tenantId, queryId: query.id }, () =>
      decide(types, employee?.fullName ?? 'the employee', transcriptText(lines), query.channel === 'voice' ? 'call' : 'whatsapp'),
    );
    if (!verdict.needs_ticket) return { done: 'not_needed' };

    const type = verdict.query_type >= 1 ? types[verdict.query_type - 1] ?? null : null;
    // The sheet is plain: a grievance is never anything but urgent, whatever the model thought.
    const priority: Priority = type && /grievance|complaint/i.test(type.name) ? 'urgent' : verdict.priority;
    const assignment = await chooseAssignee(tx, query.tenantId, type?.coeCode ?? null);
    const at = new Date();
    await tx
      .update(queries)
      .set({
        ticketStatus: 'open',
        ticketRaisedAt: at,
        queryTypeId: type?.id ?? null,
        queryTypeName: type?.name ?? null,
        coeCode: type?.coeCode ?? null,
        priority,
        problemDescription: verdict.description.trim() || null,
        assignedPersonId: assignment.personId,
        assignedTeamId: assignment.teamId,
        assignedAt: assignment.personId ? at : null,
        assignmentMark: assignment.mark,
        ticketNo: sql`nextval('ticket_no_seq')`,
      })
      .where(eq(queries.id, queryId));
    if (assignment.personId) await queueAssignmentWork(tx, query.tenantId, queryId, at);
    return { done: 'raised', queryTypeName: type?.name ?? null, personId: assignment.personId, mark: assignment.mark };
  });
}

async function askModel(types: QueryType[], employeeName: string, transcript: string, budget: 'call' | 'whatsapp'): Promise<Verdict> {
  const listed = types.length ? describeTypes(types) : '(No query types have been uploaded yet: use 0.)';
  return ask<Verdict>(TICKET_PROMPT, `QUERY TYPES\n${listed}\n\nEMPLOYEE: ${employeeName}\n\nCONVERSATION\n${transcript}`, SCHEMA, budget, 600, 'Deciding on a ticket');
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
