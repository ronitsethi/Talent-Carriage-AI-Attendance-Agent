import { asc, eq, inArray, sql } from 'drizzle-orm';
import { withPlatformScope, type Db } from '@/db';
import { coeMemberClients, coePeople, coeTeamMembers, coeTeams, queries, tenants } from '@/db/schema';
import { isPlausibleMobile, normaliseIndianMobile } from '@/lib/mapping/transforms';

/**
 * Talent Carriage's COE teams: who a ticket goes to, in what order, who takes it
 * when nobody on the team does, and who it escalates to.
 *
 * Staff only. These tables have no tenant and no row-level security, so every
 * caller of this module must have checked `isPlatformAdmin` first.
 */

export type PersonInput = { name: string; code: string; mobile: string };
/** A team member, and the companies they look after on this team. */
export type MemberInput = PersonInput & { clients: string[] };
export type TeamInput = {
  id?: string | null;
  code: string;
  fullName: string;
  members: MemberInput[];
  fallback: PersonInput | null;
  lt: PersonInput | null;
};

type Person = { fullName: string; empCode: string; mobileE164: string };
type Member = Person & { clients: string[] };
export type ValidTeam = {
  id: string | null;
  code: string;
  fullName: string;
  members: Member[];
  fallback: Person | null;
  lt: Person | null;
};

/** The form's JSON, read without trusting its shape: anything missing is empty. */
export function readTeamInput(raw: unknown): TeamInput {
  const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const person = (value: unknown): PersonInput | null => {
    if (!value || typeof value !== 'object') return null;
    const o = object(value);
    return { name: text(o.name), code: text(o.code), mobile: text(o.mobile) };
  };
  const o = object(raw);
  return {
    id: text(o.id) || null,
    code: text(o.code),
    fullName: text(o.fullName),
    members: Array.isArray(o.members)
      ? o.members.flatMap((value): MemberInput[] => {
          const member = person(value);
          const clients = object(value).clients;
          return member ? [{ ...member, clients: Array.isArray(clients) ? clients.map(text) : [] }] : [];
        })
      : [],
    fallback: person(o.fallback),
    lt: person(o.lt),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9]{2,8}$/;

/** A stored number as people read it, for a message that names it. */
const shown = (e164: string) => `+${e164}`;

/**
 * Checks a team as entered and puts it in the shape it is stored in, or says
 * everything wrong with it at once - a form that reveals one mistake per save
 * is a form people give up on.
 */
export function validateTeam(input: TeamInput): { team: ValidTeam } | { errors: string[] } {
  const errors: string[] = [];
  const code = input.code.trim().toUpperCase();
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (!CODE.test(code)) errors.push('The COE code is 2 to 8 letters or digits, like DTE or PYC.');
  if (!fullName) errors.push('Give the team its full name, like Data Management & Tools.');
  else if (fullName.length > 120) errors.push('The full name is longer than 120 characters.');

  // One number is one person, and so is one employee code: either one entered
  // against two different people is a typing mistake somewhere, and storing it
  // would quietly rename or renumber somebody.
  const byNumber = new Map<string, Person>();
  const byCode = new Map<string, Person>();
  const person = (raw: PersonInput, role: string): Person | null => {
    const name = raw.name.trim().replace(/\s+/g, ' ');
    const empCode = raw.code.trim().toUpperCase();
    const typed = raw.mobile.trim();
    if (!name && !empCode && !typed) return null;
    if (!name) {
      errors.push(`${role}: add their name.`);
      return null;
    }
    if (!empCode) {
      errors.push(`${role}: add ${name}'s employee code.`);
      return null;
    }
    if (empCode.length > 30) {
      errors.push(`${role}: "${empCode}" is too long for an employee code.`);
      return null;
    }
    const mobileE164 = normaliseIndianMobile(typed);
    if (!mobileE164 || !isPlausibleMobile(mobileE164)) {
      errors.push(`${role}: ${typed ? `"${typed}" is not a WhatsApp number` : `add ${name}'s WhatsApp number`}.`);
      return null;
    }
    const sameNumber = byNumber.get(mobileE164);
    if (sameNumber && (sameNumber.fullName.toLowerCase() !== name.toLowerCase() || sameNumber.empCode !== empCode)) {
      errors.push(
        `${shown(mobileE164)} is entered as both ${sameNumber.fullName} (${sameNumber.empCode}) and ${name} (${empCode}). One number is one person.`,
      );
      return null;
    }
    const sameCode = byCode.get(empCode);
    if (sameCode && sameCode.mobileE164 !== mobileE164) {
      errors.push(`Employee code ${empCode} is entered for both ${sameCode.fullName} and ${name}. One code is one person.`);
      return null;
    }
    const valid = { fullName: name, empCode, mobileE164 };
    byNumber.set(mobileE164, valid);
    byCode.set(empCode, valid);
    return valid;
  };

  const members: Member[] = [];
  input.members.forEach((raw, index) => {
    const found = person(raw, `Team member ${index + 1}`);
    if (!found) return;
    const member = { ...found, clients: [...new Set(raw.clients.filter((id) => UUID.test(id)))] };
    const already = members.find((m) => m.mobileE164 === member.mobileE164);
    if (already) {
      errors.push(`${already.fullName} is on the team twice.`);
      return;
    }
    members.push(member);
  });
  if (!members.length && !errors.some((e) => e.startsWith('Team member'))) {
    errors.push('Add at least one person to the warm transfer team.');
  }
  const fallback = input.fallback ? person(input.fallback, 'Fallback person') : null;
  const lt = input.lt ? person(input.lt, 'LT person') : null;

  const id = input.id && UUID.test(input.id) ? input.id : null;

  if (errors.length) return { errors };
  return { team: { id, code, fullName, members, fallback, lt } };
}

/**
 * Makes sure each person exists, by number, with the name and code last given;
 * returns their ids by number. Throws PersonClash when a code already belongs to
 * somebody on another number - that is a different person, or a typo.
 */
async function upsertPeople(tx: Db, people: Person[]): Promise<Map<string, string>> {
  const unique = [...new Map(people.map((p) => [p.mobileE164, p])).values()];
  if (!unique.length) return new Map();

  const holders = await tx
    .select()
    .from(coePeople)
    .where(inArray(coePeople.empCode, unique.map((p) => p.empCode)));
  for (const holder of holders) {
    const entered = unique.find((p) => p.empCode === holder.empCode)!;
    if (holder.mobileE164 !== entered.mobileE164) {
      throw new PersonClash(
        `Employee code ${holder.empCode} is already ${holder.fullName} on ${shown(holder.mobileE164)}, not ${entered.fullName} on ${shown(entered.mobileE164)}.`,
      );
    }
  }

  const rows = await tx
    .insert(coePeople)
    .values(unique)
    .onConflictDoUpdate({
      target: coePeople.mobileE164,
      set: { fullName: sql`excluded.full_name`, empCode: sql`excluded.emp_code`, updatedAt: sql`now()` },
    })
    .returning({ id: coePeople.id, mobileE164: coePeople.mobileE164 });
  return new Map(rows.map((row) => [row.mobileE164, row.id]));
}

/**
 * People who are on no team, named on none and hold no ticket: nothing can
 * reach them, so they go. Somebody who still holds a ticket stays, or the
 * ticket would lose who it was with.
 */
async function forgetUnused(tx: Db) {
  await tx.execute(sql`
    delete from ${coePeople} p
    where not exists (select 1 from ${coeTeamMembers} m where m.person_id = p.id)
      and not exists (select 1 from ${coeTeams} t where t.fallback_person_id = p.id or t.lt_person_id = p.id)
      and not exists (select 1 from ${queries} q where q.assigned_person_id = p.id or q.lt_person_id = p.id)
  `);
}

export class CodeTaken extends Error {}
export class PersonClash extends Error {}

/**
 * Creates the team, or replaces everything about it. Throws CodeTaken when another
 * team has the code, and PersonClash when an employee code is somebody else's.
 */
export async function saveTeam(team: ValidTeam): Promise<string> {
  return withPlatformScope(async (tx) => {
    const clash = await tx.query.coeTeams.findFirst({ where: eq(coeTeams.code, team.code) });
    if (clash && clash.id !== team.id) throw new CodeTaken(`${team.code} is already used by ${clash.fullName}.`);

    const people = [...team.members, ...(team.fallback ? [team.fallback] : []), ...(team.lt ? [team.lt] : [])];
    const ids = await upsertPeople(tx, people.map(({ fullName, empCode, mobileE164 }) => ({ fullName, empCode, mobileE164 })));
    const values = {
      code: team.code,
      fullName: team.fullName,
      fallbackPersonId: team.fallback ? ids.get(team.fallback.mobileE164)! : null,
      ltPersonId: team.lt ? ids.get(team.lt.mobileE164)! : null,
    };

    let teamId = team.id;
    if (teamId) {
      const [updated] = await tx
        .update(coeTeams)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(coeTeams.id, teamId))
        .returning({ id: coeTeams.id });
      if (!updated) throw new Error('That team has been removed.');
    } else {
      const [created] = await tx.insert(coeTeams).values(values).returning({ id: coeTeams.id });
      teamId = created!.id;
    }

    await tx.delete(coeTeamMembers).where(eq(coeTeamMembers.teamId, teamId));
    await tx
      .insert(coeTeamMembers)
      .values(team.members.map((member, index) => ({ teamId: teamId!, personId: ids.get(member.mobileE164)!, position: index + 1 })));

    await tx.delete(coeMemberClients).where(eq(coeMemberClients.teamId, teamId));
    const asked = [...new Set(team.members.flatMap((m) => m.clients))];
    // Only customers that exist; a stale form must not fail on a removed one.
    const real = asked.length
      ? new Set((await tx.select({ id: tenants.id }).from(tenants).where(inArray(tenants.id, asked))).map((row) => row.id))
      : new Set<string>();
    const looked = team.members.flatMap((member) =>
      member.clients.filter((id) => real.has(id)).map((tenantId) => ({ teamId: teamId!, personId: ids.get(member.mobileE164)!, tenantId })),
    );
    if (looked.length) await tx.insert(coeMemberClients).values(looked);

    await forgetUnused(tx);
    return teamId;
  });
}

export async function removeTeam(id: string): Promise<void> {
  if (!UUID.test(id)) return;
  await withPlatformScope(async (tx) => {
    await tx.delete(coeTeams).where(eq(coeTeams.id, id));
    await forgetUnused(tx);
  });
}

export type StoredPerson = { name: string; code: string; mobile: string };
type Client = { id: string; name: string };

export type TeamRow = {
  id: string;
  code: string;
  fullName: string;
  members: (StoredPerson & { clients: Client[] })[];
  fallback: StoredPerson | null;
  lt: StoredPerson | null;
  /** Every company somebody on the team looks after. */
  clients: Client[];
};

/** Every team, by code, with its people in order and the customers each looks after. */
export async function listTeams(): Promise<TeamRow[]> {
  return withPlatformScope(async (tx) => {
    const teams = await tx.select().from(coeTeams).orderBy(asc(coeTeams.code));
    if (!teams.length) return [];
    const teamIds = teams.map((t) => t.id);

    // One transaction is one connection: its queries go one after another.
    const members = await tx
      .select({
        teamId: coeTeamMembers.teamId,
        personId: coeTeamMembers.personId,
        name: coePeople.fullName,
        code: coePeople.empCode,
        mobile: coePeople.mobileE164,
      })
      .from(coeTeamMembers)
      .innerJoin(coePeople, eq(coePeople.id, coeTeamMembers.personId))
      .where(inArray(coeTeamMembers.teamId, teamIds))
      .orderBy(asc(coeTeamMembers.position));
    const clients = await tx
      .select({ teamId: coeMemberClients.teamId, personId: coeMemberClients.personId, id: tenants.id, name: tenants.name })
      .from(coeMemberClients)
      .innerJoin(tenants, eq(tenants.id, coeMemberClients.tenantId))
      .where(inArray(coeMemberClients.teamId, teamIds))
      .orderBy(asc(tenants.name));
    const people = await tx.select().from(coePeople);
    const byId = new Map(people.map((p) => [p.id, { name: p.fullName, code: p.empCode ?? '', mobile: p.mobileE164 }]));

    return teams.map((team) => ({
      id: team.id,
      code: team.code,
      fullName: team.fullName,
      members: members
        .filter((m) => m.teamId === team.id)
        .map(({ personId, name, code, mobile }) => ({
          name,
          code: code ?? '',
          mobile,
          clients: clients.filter((c) => c.teamId === team.id && c.personId === personId).map(({ id, name }) => ({ id, name })),
        })),
      fallback: team.fallbackPersonId ? byId.get(team.fallbackPersonId) ?? null : null,
      lt: team.ltPersonId ? byId.get(team.ltPersonId) ?? null : null,
      clients: [...new Map(clients.filter((c) => c.teamId === team.id).map((c) => [c.id, { id: c.id, name: c.name }])).values()],
    }));
  });
}

/** Everybody already entered, so a name typed on one team can fill in their code and number on another. */
export async function listPeople(): Promise<StoredPerson[]> {
  return withPlatformScope(async (tx) =>
    (await tx.select().from(coePeople).orderBy(asc(coePeople.fullName))).map((p) => ({
      name: p.fullName,
      code: p.empCode ?? '',
      mobile: p.mobileE164,
    })),
  );
}

/** The customers a team can be pointed at. */
export async function listClients(): Promise<{ id: string; name: string }[]> {
  return withPlatformScope(async (tx) =>
    tx.select({ id: tenants.id, name: tenants.name }).from(tenants).orderBy(asc(tenants.name)),
  );
}

