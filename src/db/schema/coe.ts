import { index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

/**
 * The Talent Carriage COE teams an employee's question is handed to when the
 * agent cannot settle it.
 *
 * These belong to Talent Carriage, not to a customer: one team covers several
 * customers, and one person sits on several teams. So, unlike nearly everything
 * else, there is no tenant_id and no row-level security here - only staff ever
 * reach these tables, and the pages and actions check that.
 */

/**
 * Somebody a ticket can be handed to. Known by their WhatsApp number, which is
 * how a ticket will reach them, and by their employee code: either one entered
 * on a second team is the same person, so their name is kept in one place.
 */
export const coePeople = pgTable(
  'coe_people',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fullName: text('full_name').notNull(),
    /** Their Talent Carriage employee code. Null only for people entered before codes were asked for. */
    empCode: text('emp_code'),
    /** Digits with the country code and no plus, as WhatsApp wants it. */
    mobileE164: text('mobile_e164').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('coe_people_mobile_key').on(t.mobileE164), uniqueIndex('coe_people_emp_code_key').on(t.empCode)],
);

export const coeTeams = pgTable(
  'coe_teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short and upper case - DTE, PYC - and what a ticket is filed under. */
    code: text('code').notNull(),
    fullName: text('full_name').notNull(),
    /** Who takes it when nobody on the team picks up. */
    fallbackPersonId: uuid('fallback_person_id').references(() => coePeople.id, { onDelete: 'set null' }),
    /** The leadership-team owner it escalates to. */
    ltPersonId: uuid('lt_person_id').references(() => coePeople.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('coe_teams_code_key').on(t.code)],
);

/** The warm-transfer team, in the order they are tried. */
export const coeTeamMembers = pgTable(
  'coe_team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => coeTeams.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => coePeople.id, { onDelete: 'cascade' }),
    /** 1 is tried first. */
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.personId] }), index('coe_team_members_person_idx').on(t.personId)],
);

/**
 * The customers each member looks after, on each team they are on. A ticket for
 * an employee goes to a member who looks after that employee's company.
 */
export const coeMemberClients = pgTable(
  'coe_member_clients',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => coeTeams.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => coePeople.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.personId, t.tenantId] }), index('coe_member_clients_tenant_idx').on(t.tenantId)],
);

/**
 * What an employee can ask about, and which COE handles it: one row of the
 * training sheet uploaded on the COE Teams page. The agent reads these to tell
 * what a query is, and the COE code decides which team the ticket goes to.
 *
 * The COE code is text, not a link to a team: codes are defined and redefined
 * on COE Teams at any time, and a sheet may name a code before its team exists.
 */
export const queryTypes = pgTable(
  'query_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Its row in the sheet, so they list in the sheet's order. */
    position: integer('position').notNull(),
    cluster: text('cluster'),
    coeCode: text('coe_code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    targetVariables: text('target_variables'),
    keywords: text('keywords'),
    triggerCriteria: text('trigger_criteria'),
    requiredInfo: text('required_info'),
    clarifyingQuestions: text('clarifying_questions'),
    routingNote: text('routing_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('query_types_name_key').on(t.name)],
);

/**
 * Every WhatsApp message about a ticket: to the COE person it is with - assigned,
 * reminded, escalated - and what they sent back. A reply quotes the message it
 * answers, and this is how it is matched to its ticket.
 */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryId: uuid('query_id').notNull(),
    personId: uuid('person_id').references(() => coePeople.id, { onDelete: 'set null' }),
    direction: text('direction').$type<'outbound' | 'inbound'>().notNull(),
    /** assigned | reminder | escalated | resolved | which | moved | reply */
    kind: text('kind').notNull(),
    body: text('body'),
    providerMessageId: text('provider_message_id'),
    /** queued | sent | delivered | read | failed | received | simulated */
    status: text('status').notNull().default('queued'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ticket_messages_provider_key').on(t.providerMessageId), index('ticket_messages_query_idx').on(t.queryId, t.createdAt)],
);
