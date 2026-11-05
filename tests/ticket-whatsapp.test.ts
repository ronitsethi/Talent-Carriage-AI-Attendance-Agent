import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { withPlatformScope } from '@/db';
import { coePeople, coeTeams, jobs, queries, queryTypes, ticketMessages } from '@/db/schema';
import { saveTeam, validateTeam, type MemberInput } from '@/lib/coe';
import { fakeChannelFor } from '@/lib/runtime';
import { raiseTicket, ticketLabel } from '@/lib/tickets';
import { applyTicketDeliveries, dialable, escalateToLt, handleTicketReply, informCoe, notifyAssignee, remindAssignee } from '@/lib/ticket-whatsapp';
import type { InboundMessage } from '@/lib/channels/types';
import { makeScenario, type Scenario } from './helpers/scenario';

// Unique to this run, so it never meets real rows or another test's.
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
const number = (n: number) => `96${tag.charCodeAt(0) % 10}${tag.charCodeAt(1) % 10}${String(300000 + n)}`;
const wa = (n: number) => `91${number(n)}`;
const person = (n: number, name: string, clients: string[]): MemberInput => ({ name, code: `W${tag}${n}`, mobile: number(n), clients });

let scenario: Scenario;
afterEach(async () => {
  await withPlatformScope(async (tx) => {
    await tx.delete(coeTeams).where(like(coeTeams.code, `%${tag}`));
    await tx.delete(queryTypes).where(like(queryTypes.name, `%${tag}`));
  });
  await scenario?.cleanup();
  await withPlatformScope((tx) => tx.delete(coePeople).where(like(coePeople.empCode, `W${tag}%`)));
});

/** A team of two looking after the scenario's company, an LT person, and a ticket raised and given to the first. */
async function ticketWithTeam(lt = true) {
  scenario = await makeScenario();
  const checked = validateTeam({
    code: `X${tag}`,
    fullName: 'Exit Management',
    members: [person(1, 'Honey Pawar', [scenario.tenantId]), person(2, 'Ankit Panwar', [scenario.tenantId])],
    fallback: null,
    lt: lt ? person(9, 'Jeet Vishnubhai Pawar', []) : null,
  });
  if ('errors' in checked) throw new Error(checked.errors.join('; '));
  await saveTeam(checked.team);
  await withPlatformScope((tx) => tx.insert(queryTypes).values({ position: 950, coeCode: `X${tag}`, name: `Resignation ${tag}` }));
  return raise();
}

async function raise() {
  const id = await withPlatformScope(async (tx) => {
    const [row] = await tx
      .insert(queries)
      .values({
        tenantId: scenario.tenantId,
        employeeId: scenario.employeeId,
        channel: 'voice',
        endedAt: new Date(),
        transcript: [{ role: 'employee', text: 'My FnF has not come.', at: new Date().toISOString() }],
      })
      .returning();
    return row!.id;
  });
  await raiseTicket(id, new Date(), async (types) => ({
    needs_ticket: true,
    query_type: types.findIndex((t) => t.name === `Resignation ${tag}`) + 1,
    priority: 'high',
    description: 'Ankit left on 30 September and his full and final settlement has not been paid.',
  }));
  return withPlatformScope(async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, id) }))!);
}

const history = (queryId: string) =>
  withPlatformScope((tx) => tx.select().from(ticketMessages).where(eq(ticketMessages.queryId, queryId)).orderBy(ticketMessages.createdAt));

const inbound = (from: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  providerMessageId: `in.${Math.random()}`,
  from,
  kind: 'text',
  text: 'done',
  receivedAt: new Date(),
  raw: {},
  ...extra,
});

describe('telling the COE person', () => {
  it('numbers the ticket, queues the message and both clocks, and sends it as the approved template', async () => {
    const ticket = await ticketWithTeam();
    expect(ticket.ticketNo).toBeGreaterThan(0);

    const queued = await withPlatformScope((tx) =>
      tx.select({ kind: jobs.kind, runAt: jobs.runAt }).from(jobs).where(like(jobs.dedupeKey, `ticket-%:${ticket.id}:%`)),
    );
    const at = ticket.assignedAt!.getTime();
    expect(Object.fromEntries(queued.map((j) => [j.kind, (j.runAt.getTime() - at) / 3600_000]))).toEqual({
      ticket_notify: expect.any(Number),
      ticket_reminder: 36,
      ticket_escalate: 48,
    });

    expect(await notifyAssignee(ticket.id, ticket.assignedAt!.toISOString())).toEqual({ sent: true });
    const [sent] = fakeChannelFor(scenario.tenantId).history(wa(1));
    expect(sent!.message).toMatchObject({
      kind: 'template',
      templateName: 'coe_ticket_assigned',
      buttonPayloads: [`tkt:${ticket.id}`],
      variables: [ticketLabel(ticket.ticketNo), expect.stringContaining('(E-1)'), expect.any(String), `Resignation ${tag}`, 'High', expect.stringContaining('full and final')],
    });
    // The employee's number goes with it, so the COE person can ring them.
    const mobile = scenario.mobile;
    expect((sent!.message as { variables: string[] }).variables[1]).toBe(`Ankit Panwar (E-1), phone +91 ${mobile.slice(2, 7)} ${mobile.slice(7)}`);
    // No variable may hold a line break: WhatsApp refuses the whole message.
    expect((sent!.message as { variables: string[] }).variables.every((v) => !/\n/.test(v))).toBe(true);
    expect(await history(ticket.id)).toMatchObject([{ direction: 'outbound', kind: 'assigned', status: 'simulated' }]);
  });

  it('does nothing on a clock from before the ticket was given to somebody else', async () => {
    const ticket = await ticketWithTeam();
    expect(await remindAssignee(ticket.id, new Date(0).toISOString())).toEqual({ skipped: 'resolved or reassigned since' });
    expect(await escalateToLt(ticket.id, new Date(0).toISOString())).toEqual({ skipped: 'resolved or reassigned since' });
  });
});

describe('the clocks', () => {
  it('warns at 36 hours naming the LT person, once', async () => {
    const ticket = await ticketWithTeam();
    const at = ticket.assignedAt!.toISOString();
    expect(await remindAssignee(ticket.id, at)).toEqual({ sent: true });
    const [warning] = fakeChannelFor(scenario.tenantId).history(wa(1)).filter((s) => s.message.kind === 'template');
    expect(warning!.message).toMatchObject({ templateName: 'coe_ticket_reminder', variables: [ticketLabel(ticket.ticketNo), expect.any(String), expect.any(String), 'Jeet Vishnubhai Pawar'] });
    expect(await remindAssignee(ticket.id, at)).toEqual({ skipped: 'already with the LT person, or reminded' });
  });

  it('moves it to the LT person at 48 hours, who is told why', async () => {
    const ticket = await ticketWithTeam();
    await notifyAssignee(ticket.id);
    expect(await escalateToLt(ticket.id, ticket.assignedAt!.toISOString())).toEqual({ escalatedTo: 'Jeet Vishnubhai Pawar' });

    const moved = await withPlatformScope(async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, ticket.id) }))!);
    expect(moved.ltTransferredAt).not.toBeNull();
    expect(moved.assignedPersonId).toBe(moved.ltPersonId);

    // The LT person is told, and no further clocks run: they are the last stop.
    const queued = await withPlatformScope((tx) =>
      tx.select({ kind: jobs.kind }).from(jobs).where(like(jobs.dedupeKey, `ticket-%:${ticket.id}:${moved.assignedAt!.toISOString()}`)),
    );
    expect(queued.map((j) => j.kind)).toEqual(['ticket_notify']);
    expect(await notifyAssignee(ticket.id, moved.assignedAt!.toISOString())).toEqual({ sent: true });
    const [toLt] = fakeChannelFor(scenario.tenantId).history(wa(9));
    expect(toLt!.message).toMatchObject({ templateName: 'coe_ticket_escalated', variables: expect.arrayContaining(['Honey Pawar']) });
  });

  it('cannot escalate without an LT person, and says so on the ticket', async () => {
    const ticket = await ticketWithTeam(false);
    expect(await escalateToLt(ticket.id, ticket.assignedAt!.toISOString())).toEqual({ skipped: 'no LT person to escalate to' });
    expect(await history(ticket.id)).toMatchObject([{ kind: 'escalated', status: 'failed', error: expect.stringContaining('no LT person') }]);
  });
});

describe('closing it from WhatsApp', () => {
  it('closes their only open ticket on any message, and thanks them', async () => {
    const ticket = await ticketWithTeam();
    expect(await handleTicketReply(inbound(wa(1), { text: 'ho gaya' }))).toBe(true);
    const closed = await withPlatformScope(async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, ticket.id) }))!);
    expect(closed).toMatchObject({ ticketStatus: 'resolved' });
    expect(closed.resolvedAt).not.toBeNull();
    expect(fakeChannelFor(scenario.tenantId).history(wa(1)).at(-1)!.message).toMatchObject({ kind: 'text', body: expect.stringContaining('is marked resolved') });
  });

  it('asks which, when they hold several and say nothing to tell them apart; the Resolved button closes the one it belongs to', async () => {
    const first = await ticketWithTeam();
    // Honey has one now, so the next goes to Ankit; give Honey a second by hand.
    const second = await raise();
    await withPlatformScope((tx) => tx.update(queries).set({ assignedPersonId: first.assignedPersonId }).where(eq(queries.id, second.id)));

    expect(await handleTicketReply(inbound(wa(1)))).toBe(true);
    const asked = fakeChannelFor(scenario.tenantId).history(wa(1)).at(-1)!.message;
    expect(asked).toMatchObject({ kind: 'list', rows: [{ id: `tkt:${first.id}` }, { id: `tkt:${second.id}` }] });
    const open = await withPlatformScope((tx) => tx.select().from(queries).where(and(eq(queries.assignedPersonId, first.assignedPersonId!), eq(queries.ticketStatus, 'open'))));
    expect(open).toHaveLength(2);

    expect(await handleTicketReply(inbound(wa(1), { kind: 'button', selectionId: `tkt:${second.id}`, text: undefined }))).toBe(true);
    const states = await withPlatformScope((tx) => tx.select({ id: queries.id, status: queries.ticketStatus }).from(queries).where(eq(queries.assignedPersonId, first.assignedPersonId!)));
    expect(Object.fromEntries(states.map((s) => [s.id, s.status]))).toEqual({ [first.id]: 'open', [second.id]: 'resolved' });
  });

  it('matches a reply to the ticket message it quotes', async () => {
    const ticket = await ticketWithTeam();
    await notifyAssignee(ticket.id);
    const [sent] = await history(ticket.id);
    expect(await handleTicketReply(inbound(wa(1), { replyToProviderId: sent!.providerMessageId! }))).toBe(true);
    expect((await withPlatformScope((tx) => tx.query.queries.findFirst({ where: eq(queries.id, ticket.id) })))!.ticketStatus).toBe('resolved');
  });

  it("will not close somebody else's ticket", async () => {
    const ticket = await ticketWithTeam();
    expect(await handleTicketReply(inbound(wa(2), { kind: 'button', selectionId: `tkt:${ticket.id}` }))).toBe(true);
    expect((await withPlatformScope((tx) => tx.query.queries.findFirst({ where: eq(queries.id, ticket.id) })))!.ticketStatus).toBe('open');
    expect(fakeChannelFor(scenario.tenantId).history(wa(2)).at(-1)!.message).toMatchObject({ body: expect.stringContaining('is now with Honey Pawar') });
  });

  it('leaves anybody else to the agent: a stranger, or a COE person with nothing open', async () => {
    await ticketWithTeam();
    expect(await handleTicketReply(inbound('919999999999'))).toBe(false);
    expect(await handleTicketReply(inbound(wa(2)))).toBe(false);
  });

  it("records WhatsApp's receipts for ticket messages, and only those", async () => {
    const ticket = await ticketWithTeam();
    await notifyAssignee(ticket.id);
    const [sent] = await history(ticket.id);
    const known = await applyTicketDeliveries([
      { providerMessageId: sent!.providerMessageId!, status: 'delivered', at: new Date() },
      { providerMessageId: 'wamid.someone-elses', status: 'read', at: new Date() },
    ]);
    expect([...known]).toEqual([sent!.providerMessageId]);
    expect((await history(ticket.id))[0]).toMatchObject({ status: 'delivered' });
  });
});

describe('a query that needed no ticket', () => {
  /** Two on the PF team look after the company, one does not, and one on another team does. */
  async function informed() {
    scenario = await makeScenario();
    const pf = validateTeam({
      code: `I${tag}`,
      fullName: 'Payroll',
      members: [person(1, 'Honey Pawar', [scenario.tenantId]), person(2, 'Ankit Sharma', []), person(3, 'Subodh Uniyal', [scenario.tenantId])],
      fallback: null,
      lt: null,
    });
    const other = validateTeam({ code: `J${tag}`, fullName: 'Exits', members: [person(4, 'Jeet Pawar', [scenario.tenantId])], fallback: null, lt: null });
    if ('errors' in pf || 'errors' in other) throw new Error('bad team');
    await saveTeam(pf.team);
    await saveTeam(other.team);
    await withPlatformScope((tx) => tx.insert(queryTypes).values({ position: 960, coeCode: `I${tag}`, name: `PF ${tag}` }));
    const id = await withPlatformScope(async (tx) => {
      const [row] = await tx
        .insert(queries)
        .values({
          tenantId: scenario.tenantId,
          employeeId: scenario.employeeId,
          channel: 'voice',
          endedAt: new Date(),
          transcript: [{ role: 'employee', text: 'Why is my PF lower this month?', at: new Date().toISOString() }],
        })
        .returning();
      return row!.id;
    });
    const outcome = await raiseTicket(id, new Date(), async (types) => ({
      needs_ticket: false,
      query_type: types.findIndex((t) => t.name === `PF ${tag}`) + 1,
      priority: 'low',
      description: 'Ankit asked why his PF deduction was lower in September. He was told the PF base changed with his new salary structure.',
    }));
    return { id, outcome };
  }

  it("is written up like a ticket, with no ticket, and queued for the query type's team", async () => {
    const { id, outcome } = await informed();
    expect(outcome).toEqual({ done: 'informed', queryTypeName: `PF ${tag}`, people: 2 });
    const row = await withPlatformScope(async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, id) }))!);
    expect(row).toMatchObject({ ticketStatus: null, ticketNo: null, assignedPersonId: null, queryTypeName: `PF ${tag}`, coeCode: `I${tag}` });
    expect(row.informedAt).not.toBeNull();
    expect(row.problemDescription).toContain('PF base changed');
    const queued = await withPlatformScope((tx) => tx.select({ kind: jobs.kind }).from(jobs).where(eq(jobs.dedupeKey, `query-inform:${id}`)));
    expect(queued.map((j) => j.kind)).toEqual(['query_inform']);
    // Never twice.
    expect(await raiseTicket(id, new Date(), async () => { throw new Error('asked again'); })).toEqual({ done: 'already_informed' });
  });

  it('goes to every member of that team who looks after the company, with the phone number and no Resolved button', async () => {
    const { id } = await informed();
    expect(await informCoe(id)).toEqual({ sent: 2, failed: 0 });
    const fake = fakeChannelFor(scenario.tenantId);
    expect(fake.history(wa(2))).toHaveLength(0);
    expect(fake.history(wa(4))).toHaveLength(0);
    for (const n of [1, 3]) {
      const [sent] = fake.history(wa(n));
      expect(sent!.message).toMatchObject({
        kind: 'template',
        templateName: 'coe_query_info',
        variables: [`Ankit Panwar (E-1), phone ${dialable(scenario.mobile)}`, expect.any(String), `PF ${tag}`, expect.stringContaining('PF base changed')],
      });
      expect((sent!.message as { buttonPayloads?: string[] }).buttonPayloads).toBeUndefined();
    }
    expect((await history(id)).map((m) => m.kind)).toEqual(['info', 'info']);

    // Run again: nobody hears it twice.
    expect(await informCoe(id)).toEqual({ sent: 0, failed: 0 });
  });

  it('closes nothing when a member replies to it', async () => {
    const { id } = await informed();
    await informCoe(id);
    const honey = (await withPlatformScope((tx) => tx.query.coePeople.findFirst({ where: eq(coePeople.mobileE164, wa(1)) })))!;
    const [notice] = (await history(id)).filter((m) => m.personId === honey.id);
    expect(await handleTicketReply(inbound(wa(1), { text: 'ok', replyToProviderId: notice!.providerMessageId! }))).toBe(true);
    const row = await withPlatformScope(async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, id) }))!);
    expect(row.ticketStatus).toBeNull();
    expect((await history(id)).map((m) => m.kind)).toEqual(['info', 'info', 'reply']);
  });

  it('is not shared when the employee asked nothing, or the type has nobody looking after the company', async () => {
    scenario = await makeScenario();
    await withPlatformScope((tx) => tx.insert(queryTypes).values({ position: 961, coeCode: `K${tag}`, name: `Leave ${tag}` }));
    const make = () =>
      withPlatformScope(async (tx) => {
        const [row] = await tx
          .insert(queries)
          .values({ tenantId: scenario.tenantId, employeeId: scenario.employeeId, channel: 'voice', endedAt: new Date(), transcript: [{ role: 'employee', text: 'Hello?', at: new Date().toISOString() }] })
          .returning();
        return row!.id;
      });
    const greeted = await make();
    expect(await raiseTicket(greeted, new Date(), async () => ({ needs_ticket: false, query_type: 0, priority: 'low', description: '' }))).toEqual({ done: 'not_needed' });
    const uncovered = await make();
    expect(
      await raiseTicket(uncovered, new Date(), async (types) => ({
        needs_ticket: false,
        query_type: types.findIndex((t) => t.name === `Leave ${tag}`) + 1,
        priority: 'low',
        description: 'Ankit asked how many leaves he has left.',
      })),
    ).toEqual({ done: 'not_needed' });
    const row = await withPlatformScope(async (tx) => (await tx.query.queries.findFirst({ where: eq(queries.id, uncovered) }))!);
    expect(row.informedAt).toBeNull();
  });
});

describe('the number a COE person rings', () => {
  it('reads as it is dialled', () => {
    expect(dialable('919876543210')).toBe('+91 98765 43210');
    expect(dialable('+971501234567')).toBe('+971501234567');
    expect(dialable(null)).toBeNull();
  });
});
