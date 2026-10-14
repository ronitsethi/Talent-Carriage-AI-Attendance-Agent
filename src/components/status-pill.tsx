import type { ReactNode } from 'react';
import { CircleAlert, CircleArrowRight, CircleCheck, CircleMinus, Clock } from 'lucide-react';
import { statusDisplay, type Tone } from '@/lib/display';

/**
 * A coloured pill always carries an icon as well as a word, so a state never
 * rests on colour alone - it has to survive colour blindness and a poor screen.
 */
const ICONS = {
  waiting: Clock,
  pending: CircleArrowRight,
  done: CircleCheck,
  call: CircleAlert,
  idle: CircleMinus,
} satisfies Record<Tone, unknown>;

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = ICONS[tone];
  return (
    <span className={`pill ${tone}`}>
      <Icon size={15} strokeWidth={2} aria-hidden />
      {children}
    </span>
  );
}

/** A case's status, worded and coloured the same everywhere it appears. */
export function StatusPill({ status }: { status: string }) {
  const { label, tone } = statusDisplay(status);
  return <Pill tone={tone}>{label}</Pill>;
}
