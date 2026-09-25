import { CHASED_BY_DEFAULT, EXPLAINS_ABSENCE, NEVER_CHASED, OPTIONALLY_CHASED } from '@/db/schema/enums';

export type Meaning = (typeof ALL_MEANINGS)[number];

export const ALL_MEANINGS = [
  'present',
  'absent_full',
  'absent_first_half',
  'absent_second_half',
  'absent_half_unspecified',
  'missed_punch',
  'short_hours',
  'late_in',
  'early_out',
  'leave_approved',
  'leave_pending',
  'leave_rejected',
  'leave_unpaid',
  'on_duty',
  'work_from_home',
  'travel',
  'training',
  'comp_off',
  'weekly_off',
  'holiday',
  'optional_holiday',
  'suspension',
  'long_leave',
  'not_employed',
  'unknown',
] as const;

/** Human wording used in the portal and in messages. */
export const MEANING_LABELS: Record<Meaning, string> = {
  present: 'Present',
  absent_full: 'Absent (full day)',
  absent_first_half: 'Absent (first half)',
  absent_second_half: 'Absent (second half)',
  absent_half_unspecified: 'Absent (half day)',
  missed_punch: 'Missed punch',
  short_hours: 'Short hours',
  late_in: 'Late in',
  early_out: 'Early out',
  leave_approved: 'Leave approved',
  leave_pending: 'Leave pending approval',
  leave_rejected: 'Leave rejected',
  leave_unpaid: 'Leave without pay',
  on_duty: 'On duty',
  work_from_home: 'Work from home',
  travel: 'Travel',
  training: 'Training',
  comp_off: 'Compensatory off',
  weekly_off: 'Weekly off',
  holiday: 'Holiday',
  optional_holiday: 'Optional holiday',
  suspension: 'Suspension',
  long_leave: 'Long leave',
  not_employed: 'Not employed on that date',
  unknown: 'Unknown code',
};

const NON_WORKING = new Set<Meaning>(['weekly_off', 'holiday', 'optional_holiday', 'not_employed']);

export const isNonWorking = (m: Meaning) => NON_WORKING.has(m);
export const explainsAbsence = (m: Meaning) => (EXPLAINS_ABSENCE as readonly string[]).includes(m);
export const isNeverChased = (m: Meaning) => (NEVER_CHASED as readonly string[]).includes(m);
export const isChasedByDefault = (m: Meaning) => (CHASED_BY_DEFAULT as readonly string[]).includes(m);
export const isOptionallyChased = (m: Meaning) => (OPTIONALLY_CHASED as readonly string[]).includes(m);

/**
 * Whether a day should be chased, given the tenant's configuration.
 *
 * `NEVER_CHASED` wins over everything, including an explicit tenant setting and
 * an explicit per-code override: a weekly off or an unmapped code must not
 * produce a message, however the system is configured.
 */
export function shouldChase(
  meaning: Meaning,
  opts: { tenantChaseMeanings?: string[]; codeOverride?: boolean | null } = {},
): boolean {
  if (isNeverChased(meaning)) return false;
  if (opts.codeOverride === true) return true;
  if (opts.codeOverride === false) return false;
  if (isChasedByDefault(meaning)) return true;
  if (isOptionallyChased(meaning)) return (opts.tenantChaseMeanings ?? []).includes(meaning);
  return false;
}

/** The half of the day a meaning refers to, used to word the message precisely. */
export function halfOfDay(meaning: Meaning): 'first' | 'second' | 'full' | null {
  switch (meaning) {
    case 'absent_first_half':
      return 'first';
    case 'absent_second_half':
      return 'second';
    case 'absent_full':
      return 'full';
    case 'absent_half_unspecified':
      return null;
    default:
      return null;
  }
}

/**
 * Combine the two halves of a two-session code (`P|A`, `A|WO`, `CL|A`) into one
 * meaning. Tenants can always map the whole string explicitly; this is the
 * fallback when only the individual halves are mapped.
 */
export function combineSessions(first: Meaning, second: Meaning): Meaning {
  if (first === second) return first;

  const absent = (m: Meaning) => m === 'absent_full' || m === 'absent_half_unspecified' || m.startsWith('absent');
  const firstAbsent = absent(first);
  const secondAbsent = absent(second);

  if (firstAbsent && secondAbsent) return 'absent_full';
  if (firstAbsent) return 'absent_first_half';
  if (secondAbsent) return 'absent_second_half';

  // Neither half is an absence. A real gap in one half still wins over a benign
  // other half, so a missed punch is not lost behind a weekly off.
  const gapRank: Meaning[] = ['missed_punch', 'short_hours', 'late_in', 'early_out', 'leave_pending', 'leave_rejected'];
  for (const m of gapRank) {
    if (first === m || second === m) return m;
  }

  // Otherwise prefer the half that describes actual work or approved absence.
  if (isNonWorking(first)) return second;
  if (isNonWorking(second)) return first;
  return first;
}
