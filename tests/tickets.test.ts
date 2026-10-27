import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { eq, inArray, like } from 'drizzle-orm';
import { withPlatformScope } from '@/db';
import { coePeople, coeTeams, queries, queryTypes } from '@/db/schema';
import { saveTeam, validateTeam, type MemberInput } from '@/lib/coe';
import { parseQueryTypeSheet, templateWorkbook } from '@/lib/query-types';
import { chooseAssignee, leastBusy, raiseTicket } from '@/lib/tickets';
import { makeScenario, type Scenario } from './helpers/scenario';

// Unique to this run, so it never meets real rows or another test's.
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
const number = (n: number) => `97${tag.charCodeAt(0) % 10}${tag.charCodeAt(1) % 10}${String(200000 + n)}`;
const person = (n: number, name: string, clients: string[]): MemberInput => ({ name, code: `K${tag}${n}`, mobile: number(n), clients });

async function team(code: string, members: MemberInput[], lt?: MemberInput) {
  const checked = validateTeam({ code, fullName: `Team ${code}`, members, fallback: null, lt: lt ?? null });
  if ('errors' in checked) throw new Error(checked.errors.join('; '));
  return saveTeam(checked.team);
}

const idsOf = async (ns: number[]) =>
  withPlatformScope(async (tx) => {
    const rows = await tx.select().from(coePeople).where(inArray(coePeople.mobileE164, ns.map((n) => `91${number(n)}`)));
    return ns.map((n) => rows.find((r) => r.mobileE164 === `91${number(n)}`)!.id);
  });

/** Gives somebody open tickets, as queries already assigned to them. */
async function giveOpen(tenantId: string, employeeId: string, personId: string, count: number) {
  await withPlatformScope(async (tx) => {
    for (let i = 0; i < count; i++) {
      await tx.insert(queries).values({ tenantId, employeeId, channel: 'voice', ticketStatus: 'open', assignedPersonId: personId });
    }
  });
}

let scenarios: Scenario[] = [];
afterEach(async () => {
  await withPlatformScope(async (tx) => {
    await tx.delete(coeTeams).where(like(coeTeams.code, `%${tag}`));
    await tx.delete(queryTypes).where(like(queryTypes.name, `%${tag}`));
  });
  for (const scenario of scenarios) await scenario.cleanup(); // takes their queries with them
  await withPlatformScope((tx) => tx.delete(coePeople).where(like(coePeople.empCode, `K${tag}%`)));
  scenarios = [];
});

describe('the least busy member', () => {
  const a = { personId: 'a', teamId: 't' };
  const b = { personId: 'b', teamId: 't' };
  const c = { personId: 'c', teamId: 't' };

  it('is the first when nobody has a ticket, or everybody has the same', () => {
    expect(leastBusy([a, b, c], new Map())).toBe(a);
    expect(leastBusy([a, b, c], new Map([['a', 1], ['b', 1], ['c', 1]]))).toBe(a);
  });

  it('moves down the list past whoever already has one', () => {
    expect(leastBusy([a, b, c], new Map([['a', 1]]))).toBe(b);
    expect(leastBusy([a, b, c], new Map([['a', 1], ['b', 1]]))).toBe(c);
  });

  it('is whoever has the fewest: A 2, B 3, C 1 goes to C', () => {
    expect(leastBusy([a, b, c], new Map([['a', 2], ['b', 3], ['c', 1]]))).toBe(c);
  });
});

describe('choosing who a ticket goes to', () => {
  it('only considers the members who look after the company', async () => {
    const scenario = await makeScenario();
    scenarios.push(scenario);
    const other = await makeScenario();
    scenarios.push(other);
    // Five on the team; the 2nd, 3rd and 5th look after this company.
    await team(`D${tag}`, [
      person(1, 'One', [other.tenantId]),
      person(2, 'Two', [scenario.tenantId]),
      person(3, 'Three', [scenario.tenantId, other.tenantId]),
      person(4, 'Four', []),
      person(5, 'Five', [scenario.tenantId]),
    ]);
    const [one, two, three, , five] = await idsOf([1, 2, 3, 4, 5]);

    const first = await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, `D${tag}`));
    expect(first).toMatchObject({ personId: two, mark: null });

    // Busy elsewhere counts too: Two's ticket for another company still makes Two busier.
    await giveOpen(other.tenantId, other.employeeId, two!, 1);
    await giveOpen(scenario.tenantId, scenario.employeeId, three!, 1);
    expect((await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, `D${tag}`))).personId).toBe(five);

    // A resolved ticket is not work: only open ones count.
    await withPlatformScope((tx) => tx.update(queries).set({ ticketStatus: 'resolved' }).where(eq(queries.assignedPersonId, two!)));
    expect((await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, `D${tag}`))).personId).toBe(two);
    expect(one).toBeTruthy();
  });

  it("goes to another team's member, marked, when nobody on the right team looks after the company", async () => {
    const scenario = await makeScenario();
    scenarios.push(scenario);
    await team(`D${tag}`, [person(1, 'One', [])]);
    await team(`P${tag}`, [person(2, 'Two', [scenario.tenantId])]);
    const [two] = await idsOf([2]);

    expect(await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, `D${tag}`))).toMatchObject({ personId: two, mark: 'other_team' });
    // A code no team has yet is treated the same.
    expect(await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, `X${tag}`))).toMatchObject({ personId: two, mark: 'other_team' });
  });

  it('waits, marked, when nobody looks after the company or the query matched no type', async () => {
    const scenario = await makeScenario();
    scenarios.push(scenario);
    expect(await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, `D${tag}`))).toEqual({ personId: null, teamId: null, mark: 'no_cover' });
    expect(await withPlatformScope((tx) => chooseAssignee(tx, scenario.tenantId, null))).toEqual({ personId: null, teamId: null, mark: 'no_type' });
  });
});

describe('raising a ticket after the conversation', () => {
  async function callQuery(scenario: Scenario, ended = true) {
    return withPlatformScope(async (tx) => {
      const [row] = await tx
        .insert(queries)
        .values({
          tenantId: scenario.tenantId,
          employeeId: scenario.employeeId,
          channel: 'voice',
          endedAt: ended ? new Date() : null,
          transcript: [
            { role: 'agent', text: 'How can I help you?', at: new Date().toISOString() },
            { role: 'employee', text: 'Mera PF September mein kam kata, kyun?', at: new Date().toISOString() },
            { role: 'agent', text: 'I will log this and HR will explain.', at: new Date().toISOString() },
          ],
        })
        .returning();
      return row!.id;
    });
  }

  async function addTypes() {
    await withPlatformScope((tx) =>
      tx.insert(queryTypes).values([
        { position: 900, coeCode: `P${tag}`, name: `PF ${tag}`, description: 'PF questions' },
        { position: 901, coeCode: `E${tag}`, name: `Grievance/Complaint ${tag}`, description: 'Complaints' },
      ]),
    );
  }

  it('writes the type, priority and problem, and assigns it', async () => {
    const scenario = await makeScenario();
    scenarios.push(scenario);
    await addTypes();
    await team(`P${tag}`, [person(1, 'Subodh Uniyal', [scenario.tenantId])]);
    const [subodh] = await idsOf([1]);
    const id = await callQuery(scenario);

    const outcome = await raiseTicket(id, new Date(), async (types) => ({
      needs_ticket: true,
      query_type: types.findIndex((t) => t.name === `PF ${tag}`) + 1,
      priority: 'medium',
      description: 'Ankit wants to know why his September PF deduction was lower.',
    }));
    expect(outcome).toMatchObject({ done: 'raised', personId: subodh, mark: null });

    const row = await withPlatformScope((tx) => tx.query.queries.findFirst({ where: eq(queries.id, id) }));
    expect(row).toMatchObject({
      ticketStatus: 'open',
      queryTypeName: `PF ${tag}`,
      coeCode: `P${tag}`,
      priority: 'medium',
      problemDescription: 'Ankit wants to know why his September PF deduction was lower.',
      assignedPersonId: subodh,
    });

    // Never twice.
    expect(await raiseTicket(id, new Date(), async () => { throw new Error('asked again'); })).toEqual({ done: 'already_raised' });
  });

  it('makes a grievance urgent whatever the model said', async () => {
    const scenario = await makeScenario();
    scenarios.push(scenario);
    await addTypes();
    const id = await callQuery(scenario);
    await raiseTicket(id, new Date(), async (types) => ({
      needs_ticket: true,
      query_type: types.findIndex((t) => t.name === `Grievance/Complaint ${tag}`) + 1,
      priority: 'low',
      description: 'A complaint about a manager.',
    }));
    const row = await withPlatformScope((tx) => tx.query.queries.findFirst({ where: eq(queries.id, id) }));
    expect(row).toMatchObject({ priority: 'urgent', assignmentMark: 'no_cover', assignedPersonId: null });
  });

  it('raises nothing when everything was answered, and waits for a call still going', async () => {
    const scenario = await makeScenario();
    scenarios.push(scenario);
    const answered = await callQuery(scenario);
    expect(await raiseTicket(answered, new Date(), async () => ({ needs_ticket: false, query_type: 0, priority: 'low', description: '' }))).toEqual({
      done: 'not_needed',
    });
    const row = await withPlatformScope((tx) => tx.query.queries.findFirst({ where: eq(queries.id, answered) }));
    expect(row?.ticketStatus).toBeNull();

    const going = await callQuery(scenario, false);
    expect((await raiseTicket(going, new Date(), async () => { throw new Error('should wait'); })).done).toBe('later');
  });
});

describe('reading the training sheet', () => {
  it('reads back the sample sheet it offers for download', () => {
    const parsed = parseQueryTypeSheet(templateWorkbook());
    expect('rows' in parsed && parsed.rows.map((r) => [r.coeCode, r.name])).toEqual([
      ['PYC', 'Payslip'],
      ['EMP', 'Grievance/Complaint'],
    ]);
    expect('rows' in parsed && parsed.rows[0]).toMatchObject({
      cluster: 'Payroll and Compensation',
      routingNote: 'Payroll Support - [Client] queue',
      requiredInfo: expect.stringContaining('Which month'),
    });
  });


  const book = (rows: unknown[][]) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };

  it('finds the columns by their headings, in any order', () => {
    const parsed = parseQueryTypeSheet(
      book([
        ['Keywords & Trigger Phrases', 'Type of Query', 'Suggested Cluster', 'COE', 'Description'],
        ['payslip nahi mil raha', 'Payslip', 'Payroll', ' pyc ', 'Payslip problems'],
        ['', '', '', '', ''],
        ['leave lagani hai', 'Leaves/Holidays', 'Time & Attendance', 'DTE', ''],
      ]),
    );
    expect(parsed).toEqual({
      rows: [
        expect.objectContaining({ position: 1, coeCode: 'PYC', name: 'Payslip', cluster: 'Payroll', keywords: 'payslip nahi mil raha', description: 'Payslip problems' }),
        expect.objectContaining({ position: 2, coeCode: 'DTE', name: 'Leaves/Holidays', description: null }),
      ],
    });
  });

  it('lists every problem at once', () => {
    const parsed = parseQueryTypeSheet(
      book([
        ['COE', 'Type of Query'],
        ['', 'Payslip'],
        ['PYC', 'Payslip'],
        ['DTE', 'Payslip'],
      ]),
    );
    expect(parsed).toEqual({
      errors: [
        'Row 2 (Payslip): "nothing" is not a COE code - 2 to 8 letters or digits, like DTE.',
        'Row 4: "Payslip" is already on row 3. Each type of query is listed once.',
      ],
    });
    expect(parseQueryTypeSheet(book([['Name', 'Code'], ['a', 'b']]))).toEqual({
      errors: ['No sheet has a "COE" column and a "Type of Query" column. Check the heading row.'],
    });
  });
});
