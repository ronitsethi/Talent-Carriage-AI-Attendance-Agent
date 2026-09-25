import { MEANING_LABELS, type Meaning } from '@/lib/mapping/meanings';
import { OPTIONS, dateLabel, type OptionNumber } from '@/lib/conversation/flow';

/** Presentation helpers shared by the portal pages. */

export const STATUS_DISPLAY: Record<string, { label: string; tone: 'waiting' | 'pending' | 'done' | 'call' | 'idle' }> = {
  queued: { label: 'Queued', tone: 'idle' },
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
};

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
