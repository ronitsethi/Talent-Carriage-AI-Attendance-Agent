import type { FollowUpContact } from '@/db/schema';

/**
 * How each reminder and each follow-up goes: its row in Settings, WhatsApp or
 * a call, and the call style. A row set to Call is only a call when the rest of
 * the call rule allows it too (`callRuleFor`); a WhatsApp row never is.
 *
 * Kept free of server imports: the Settings rows use it in the browser to show
 * the default for a level not saved yet.
 */

export type LevelKind = 'reminder' | 'follow_up';
export type CallStyle = 'keypad' | 'agent';
export type LevelContact = { channel: 'whatsapp' | 'voice'; callMode: CallStyle };

/** What the defaults need from the customer's settings. */
export type LevelSettings = {
  reminderContacts: FollowUpContact[];
  followUpContacts: FollowUpContact[];
  remindersBeforeEscalation: number;
  maxFollowUps: number;
  /** Kept from before the rows: a customer who switched calls off keeps them off by default. */
  reminderCallsAllowed: boolean;
  followUpCallsAllowed: boolean;
  reminderCallMode: string;
  followUpCallMode: string;
};

const style = (value: string | null | undefined): CallStyle => (value === 'agent' ? 'agent' : 'keypad');

/** How many rows a kind has: one per reminder, one per follow-up (the last is the final notice). */
export function levelCount(settings: Pick<LevelSettings, 'remindersBeforeEscalation' | 'maxFollowUps'>, kind: LevelKind): number {
  return kind === 'reminder' ? Math.max(0, settings.remindersBeforeEscalation) : Math.max(1, settings.maxFollowUps);
}

/**
 * A level with no row saved. Reminders: a call for the last warning. Follow-ups:
 * a call for the one before the final notice. The first of each is always
 * WhatsApp, and so is everything when the customer had switched calls off.
 */
export function defaultLevelContact(settings: LevelSettings, kind: LevelKind, level: number, count = levelCount(settings, kind)): LevelContact {
  const reminder = kind === 'reminder';
  const allowed = reminder ? settings.reminderCallsAllowed : settings.followUpCallsAllowed;
  const callLevel = reminder ? count : count - 1;
  const call = allowed && level >= 2 && level === callLevel;
  return { channel: call ? 'voice' : 'whatsapp', callMode: style(reminder ? settings.reminderCallMode : settings.followUpCallMode) };
}

/** How one level goes: its saved row, else the default. `level` counts from 1. */
export function levelContact(settings: LevelSettings, kind: LevelKind, level: number): LevelContact {
  const saved = (kind === 'reminder' ? settings.reminderContacts : settings.followUpContacts)?.[level - 1];
  const fallback = defaultLevelContact(settings, kind, level);
  if (!saved?.channel) return { ...fallback, callMode: saved?.callMode ? style(saved.callMode) : fallback.callMode };
  return { channel: saved.channel === 'voice' ? 'voice' : 'whatsapp', callMode: saved.callMode ? style(saved.callMode) : fallback.callMode };
}
