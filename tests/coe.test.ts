import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { withPlatformScope } from '@/db';
import { coePeople, coeTeams } from '@/db/schema';
import {
  CodeTaken,
  listTeams,
  PersonClash,
  readTeamInput,
  removeTeam,
  saveTeam,
  validateTeam,
  type MemberInput,
  type PersonInput,
  type TeamInput,
  type ValidTeam,
} from '@/lib/coe';
import { makeScenario, type Scenario } from './helpers/scenario';

// Codes and numbers unique to this run, so it never meets real rows or another test's.
const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
const number = (n: number) => `98${tag.charCodeAt(0) % 10}${tag.charCodeAt(1) % 10}${String(100000 + n)}`;
const code = (n: number) => `T${tag}${n}`;
const who = (n: number, name: string, mobile = number(n)): PersonInput => ({ name, code: code(n), mobile });
const member = (n: number, name: string, clients: string[] = [], mobile = number(n)): MemberInput => ({ ...who(n, name, mobile), clients });

const input = (overrides: Partial<TeamInput> = {}): TeamInput => ({
  code: `D${tag}`,
  fullName: 'Data Management & Tools',
  members: [member(1, 'Honey Pawar'), member(2, 'Vinit Ramesh Bhatiya', [], `+91 ${number(2)}`)],
  fallback: who(3, 'Shridhar Adiveppa Patil'),
  lt: who(4, 'Vivek Singh'),
  ...overrides,
});

const valid = (overrides: Partial<TeamInput> = {}): ValidTeam => {
  const checked = validateTeam(input(overrides));
  if ('errors' in checked) throw new Error(checked.errors.join('; '));
  return checked.team;
};

let scenario: Scenario | null = null;
afterEach(async () => {
  await withPlatformScope(async (tx) => {
    await tx.delete(coeTeams).where(inArray(coeTeams.code, [`D${tag}`, `P${tag}`]));
    await tx.delete(coePeople).where(inArray(coePeople.mobileE164, [1, 2, 3, 4, 5, 6].map((n) => `91${number(n)}`)));
  });
  await scenario?.cleanup();
  scenario = null;
});

describe('checking a COE team', () => {
  it('stores numbers the way WhatsApp wants them, and codes in capitals', () => {
    const team = valid({ code: ` d${tag.toLowerCase()} `, members: [{ name: 'Honey Pawar', code: ` ${code(1).toLowerCase()} `, mobile: number(1), clients: [] }] });
    expect(team.code).toBe(`D${tag}`);
    expect(team.members).toEqual([{ fullName: 'Honey Pawar', empCode: code(1), mobileE164: `91${number(1)}`, clients: [] }]);
  });

  it('says everything wrong at once', () => {
    const checked = validateTeam(
      input({
        code: 'x',
        fullName: ' ',
        members: [
          { name: 'Honey Pawar', code: code(1), mobile: '12', clients: [] },
          { name: '', code: code(9), mobile: number(9), clients: [] },
          { name: 'Riya Kaul', code: '', mobile: number(6), clients: [] },
        ],
      }),
    );
    expect('errors' in checked && checked.errors).toEqual([
      'The COE code is 2 to 8 letters or digits, like DTE or PYC.',
      'Give the team its full name, like Data Management & Tools.',
      'Team member 1: "12" is not a WhatsApp number.',
      'Team member 2: add their name.',
      "Team member 3: add Riya Kaul's employee code.",
    ]);
  });

  it('will not take one number or one code for two people, or one person twice', () => {
    const renamed = validateTeam(input({ fallback: { name: 'Somebody Else', code: code(5), mobile: number(1) } }));
    expect('errors' in renamed && renamed.errors[0]).toMatch(/entered as both Honey Pawar .* and Somebody Else/);

    const shared = validateTeam(input({ lt: { name: 'Vivek Singh', code: code(1), mobile: number(4) } }));
    expect('errors' in shared && shared.errors).toEqual([`Employee code ${code(1)} is entered for both Honey Pawar and Vivek Singh. One code is one person.`]);

    const twice = validateTeam(input({ members: [member(1, 'Honey Pawar'), member(1, 'honey pawar')] }));
    expect('errors' in twice && twice.errors).toEqual(['Honey Pawar is on the team twice.']);
  });

  it('needs somebody on the team, but not a fallback or LT person', () => {
    const empty = validateTeam(input({ members: [] }));
    expect('errors' in empty && empty.errors).toEqual(['Add at least one person to the warm transfer team.']);
    expect(valid({ fallback: { name: '', code: '', mobile: '' }, lt: null })).toMatchObject({ fallback: null, lt: null });
  });

  it('reads a malformed form as empty rather than failing', () => {
    expect(readTeamInput({ code: 3, members: [null, { name: 'A', clients: 'x' }] })).toEqual({
      id: null,
      code: '',
      fullName: '',
      members: [{ name: 'A', code: '', mobile: '', clients: [] }],
      fallback: null,
      lt: null,
    });
  });
});

describe('saving COE teams', () => {
  it('keeps one person per number across teams, in the order given, with the companies each looks after', async () => {
    scenario = await makeScenario();
    const id = await saveTeam(valid({ members: [member(1, 'Honey Pawar', [scenario.tenantId]), member(2, 'Vinit Ramesh Bhatiya')] }));
    await saveTeam(
      valid({
        code: `P${tag}`,
        fullName: 'Payroll & Compliance',
        // Honey again, now second, under her full name.
        members: [member(5, 'Ankit Panwar'), member(1, 'Honey Vishal Pawar')],
      }),
    );

    const teams = (await listTeams()).filter((t) => t.code.endsWith(tag));
    const dte = teams.find((t) => t.id === id)!;
    expect(dte.members.map(({ name, code, clients }) => ({ name, code, clients: clients.map((c) => c.id) }))).toEqual([
      { name: 'Honey Vishal Pawar', code: code(1), clients: [scenario.tenantId] },
      { name: 'Vinit Ramesh Bhatiya', code: code(2), clients: [] },
    ]);
    expect(dte.fallback).toEqual({ name: 'Shridhar Adiveppa Patil', code: code(3), mobile: `91${number(3)}` });
    expect(dte.clients.map((c) => c.id)).toEqual([scenario.tenantId]);
    expect(teams.find((t) => t.code === `P${tag}`)!.members.map((m) => m.name)).toEqual(['Ankit Panwar', 'Honey Vishal Pawar']);

    const honey = await withPlatformScope((tx) => tx.select().from(coePeople).where(eq(coePeople.mobileE164, `91${number(1)}`)));
    expect(honey).toHaveLength(1);
  });

  it("refuses a code that is already somebody else's on another number", async () => {
    await saveTeam(valid());
    // Honey's code, typed against a new number on another team.
    const clash = valid({ code: `P${tag}`, fullName: 'Payroll & Compliance', members: [member(1, 'Honey Pawar', [], number(6))] });
    await expect(saveTeam(clash)).rejects.toThrow(PersonClash);
    await expect(saveTeam(clash)).rejects.toThrow(`Employee code ${code(1)} is already Honey Pawar on +91${number(1)}`);
  });

  it('refuses a COE code another team has, and edits a team in place', async () => {
    const id = await saveTeam(valid());
    await expect(saveTeam(valid())).rejects.toBeInstanceOf(CodeTaken);

    await saveTeam({ ...valid({ fullName: 'Data Management' }), id });
    const [team] = (await listTeams()).filter((t) => t.id === id);
    expect(team!.fullName).toBe('Data Management');
  });

  it('forgets people nobody can reach any more', async () => {
    const id = await saveTeam(valid());
    await saveTeam({ ...valid({ members: [member(1, 'Honey Pawar')], fallback: null }), id });
    const gone = await withPlatformScope((tx) =>
      tx.select().from(coePeople).where(inArray(coePeople.mobileE164, [`91${number(2)}`, `91${number(3)}`])),
    );
    expect(gone).toEqual([]);

    await removeTeam(id);
    const left = await withPlatformScope((tx) => tx.select().from(coePeople).where(eq(coePeople.mobileE164, `91${number(1)}`)));
    expect(left).toEqual([]);
  });
});
