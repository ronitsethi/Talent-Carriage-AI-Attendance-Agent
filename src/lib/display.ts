import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { OPTIONS, dateLabel, type OptionNumber } from '@/lib/conversation/flow';

/** Presentation helpers shared by the portal pages. */

/** waiting = info, pending = warning, done = success, call = needs attention, idle = neutral. */
export type Tone = 'waiting' | 'pending' | 'done' | 'call' | 'idle';

export const STATUS_DISPLAY: Record<string, { label: string; tone: Tone }> = {
  // Not "Queued": nothing is waiting in a queue. The case exists because the
  // absence was found, and nobody has been contacted about it yet.
  queued: { label: 'Not contacted', tone: 'idle' },
  asked: { label: 'Asked · awaiting reply', tone: 'waiting' },
  delivered: { label: 'Delivered · awaiting reply', tone: 'waiting' },
  read: { label: 'Read · awaiting reply', tone: 'waiting' },
  answered: { label: 'Answered · guidance sent', tone: 'pending' },
  awaiting_action: { label: 'Offer sent', tone: 'pending' },
  awaiting_approval: { label: 'With the manager', tone: 'pending' },
  resolved: { label: 'Resolved', tone: 'done' },
  needs_hr: { label: 'Needs HR', tone: 'call' },
  failed: { label: 'Send failed', tone: 'call' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
  // Once the follow-up has gone out, the case is waiting on that instead.
  follow_up_awaiting: { label: 'Follow-up sent · awaiting reply', tone: 'waiting' },
  follow_up_not_done: { label: 'Follow-up · not done yet', tone: 'pending' },
};

type FollowUpFields = { status: string; followUpDueAt: Date | null; followUpSentAt: Date | null; followUpReply: string | null };

/**
 * The status a case shows: its own until the follow-up goes out, and then the
 * follow-up's - unless the case has since been settled one way or another.
 */
export function caseStatus(row: FollowUpFields): string {
  if (!row.followUpSentAt || ['resolved', 'needs_hr', 'failed', 'cancelled'].includes(row.status)) return row.status;
  if (!row.followUpReply) return 'follow_up_awaiting';
  if (row.followUpReply === 'not_done') return 'follow_up_not_done';
  return row.status;
}

const RESOLVED_LABELS: Record<string, string> = { yes: 'Answered', partly: 'Partly answered', no: 'Not answered' };
const RATING_LABELS: Record<string, string> = { good: 'Good', okay: 'Okay', poor: 'Poor' };

/** What an employee said about a call they made to us, in words; null if never asked. */
export function feedbackLabel(row: {
  feedbackSentAt: Date | null;
  feedbackResolved: string | null;
  feedbackRating: string | null;
  feedbackComment: string | null;
}): { resolved: string; rating: string; comment: string | null; summary: string } | null {
  if (!row.feedbackSentAt) return null;
  const resolved = row.feedbackResolved ? RESOLVED_LABELS[row.feedbackResolved] ?? row.feedbackResolved : 'No reply';
  const rating = row.feedbackRating ? RATING_LABELS[row.feedbackRating] ?? row.feedbackRating : 'No reply';
  const summary = row.feedbackResolved || row.feedbackRating ? [row.feedbackResolved && resolved, row.feedbackRating && `${rating} call`].filter(Boolean).join(' · ') : 'Asked · no reply yet';
  return { resolved, rating, comment: row.feedbackComment, summary };
}

const FOLLOW_UP_REPLIES: Record<string, string> = { done: 'Done', not_done: 'Not done yet', help: 'Asked for help' };

/** When the follow-up went, or is due, and what they said to it. Null if none is planned. */
export function followUpLabel(row: FollowUpFields): { when: string; note: string } | null {
  if (row.followUpSentAt) {
    return { when: formatTime(row.followUpSentAt), note: row.followUpReply ? FOLLOW_UP_REPLIES[row.followUpReply] ?? row.followUpReply : 'Awaiting reply' };
  }
  if (row.followUpDueAt) return { when: `Due ${formatTime(row.followUpDueAt)}`, note: 'Not sent yet' };
  return null;
}

export function statusDisplay(status: string) {
  return STATUS_DISPLAY[status] ?? { label: status, tone: 'idle' as const };
}

export function meaningLabel(meaning: string): string {
  return MEANING_LABELS[meaning as Meaning] ?? meaning;
}

export function caseDateLabel(attDate: string, meaning: string): string {
  return dateLabel(attDate, meaning as Meaning);
}

export function replyLabel(option: number | null): string | null {
  if (!option) return null;
  const o = OPTIONS[option as OptionNumber];
  return o ? `${option} · ${o.label}` : null;
}

export function actionLabel(option: number | null): string | null {
  if (!option) return null;
  return OPTIONS[option as OptionNumber]?.action ?? null;
}

export function formatTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

export function relativeDays(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
