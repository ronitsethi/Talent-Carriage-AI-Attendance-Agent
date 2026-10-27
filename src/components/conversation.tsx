import { Fragment, type ReactNode } from 'react';
import { Check, CheckCheck, ChevronDown, Download, MessageCircle, Phone } from 'lucide-react';
import { clockTime, dayLabel, durationLabel, formatTime, initials } from '@/lib/display';
import { AudioPlayer } from '@/components/audio-player';

/**
 * How a conversation reads on screen.
 *
 * Two skins, because the two channels are two different things to read. A chat
 * is shown the way the employee saw it on their phone: the sand paper, green
 * for us, white for them, and ticks on our side. A call is shown as a
 * transcript, one panel per call with its recording at the top, because HR
 * listens and reads at the same time.
 *
 * Both put the employee's name over their own lines: on a long thread that is
 * what makes it scannable, without counting which side a bubble sits on.
 */

export type Skin = 'wa' | 'call';

export type Turn = {
  kind: 'turn';
  key: string;
  /** Sorted on, and where it crosses midnight a day pill goes in. */
  at: string;
  side: 'inbound' | 'outbound';
  body: string;
  /** The reply buttons that went with a WhatsApp message. */
  options?: string;
  /** A word under the bubble when one is worth saying: `cut off`, `template`. */
  note?: string;
  /** A WhatsApp message's delivery state, drawn as ticks on our own messages. */
  state?: string | null;
};

/** A line across the thread: where the follow-up starts, or where feedback does. */
export type Mark = { kind: 'mark'; key: string; at: string; label: string };
export type Entry = Turn | Mark;

/** One tick sent, two delivered, two in blue once they have read it. */
function Ticks({ state }: { state: string }) {
  if (state === 'failed') return <span className="tick failed" aria-hidden>!</span>;
  if (state === 'queued' || state === 'simulated') return null;
  if (state === 'sent') return <Check size={14} className="tick" aria-hidden />;
  return <CheckCheck size={14} className={`tick${state === 'read' ? ' read' : ''}`} aria-hidden />;
}

function Bubble({ turn, skin, name }: { turn: Turn; skin: Skin; name: string }) {
  const theirs = turn.side === 'inbound';
  // On a chat we are the business and have no face; on a call the agent gets
  // one, because there it is a voice in the room like any other.
  const avatar = theirs ? initials(name) : skin === 'call' ? 'AI' : null;
  return (
    <div className={`turn ${theirs ? 'theirs' : 'ours'}`}>
      {avatar ? (
        <span className={`turn-avatar${theirs ? '' : ' agent'}`} aria-hidden>
          {avatar}
        </span>
      ) : null}
      <div className="turn-body">
        {theirs ? <span className="turn-name">{name}</span> : null}
        <div className={`bubble ${skin} ${turn.side}`}>
          <span className="bubble-text">{turn.body}</span>
          {turn.options ? <span className="options">{turn.options}</span> : null}
          <span className="bubble-foot">
            {turn.note ? <span className="bubble-note">{turn.note}</span> : null}
            <time>{clockTime(turn.at)}</time>
            {!theirs && turn.state ? <Ticks state={turn.state} /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The thread itself. Entries come oldest first and are reversed into a
 * column-reverse box: it reads in order and opens at the newest line.
 */
export function Thread({ entries, skin, name, empty }: { entries: Entry[]; skin: Skin; name: string; empty: string }) {
  if (!entries.some((entry) => entry.kind === 'turn')) return <div className="chat-empty">{empty}</div>;
  // A pill carries the date wherever the thread crosses midnight, and above the
  // first line, so no bubble is left without a day.
  let previousDay: string | null = null;
  const dated = entries.map((entry) => {
    const day = dayLabel(entry.at);
    const starts = day !== previousDay;
    previousDay = day;
    return { entry, day: starts ? day : null };
  });

  return (
    <>
      {/* Reversed: in a column-reverse box the pill after a bubble sits above it. */}
      {[...dated].reverse().map(({ entry, day }) => (
        <Fragment key={entry.key}>
          {entry.kind === 'mark' ? (
            <div className="chat-divider">
              <span>{entry.label}</span>
            </div>
          ) : (
            <Bubble turn={entry} skin={skin} name={name} />
          )}
          {day ? (
            <div className="day-pill">
              <span>{day}</span>
            </div>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

/** A chat's header: who it is with, on the WhatsApp bar. */
export function ChatHead({ name, number }: { name: string; number: string | null }) {
  return (
    <div className="chat-head">
      <span className="chat-head-avatar" aria-hidden>
        {initials(name)}
      </span>
      <div className="chat-head-text">
        <span className="chat-head-name">{name}</span>
        <span className="chat-head-sub">WhatsApp{number ? ` · +${number}` : ''}</span>
      </div>
      <MessageCircle size={20} className="chat-head-icon" aria-hidden />
    </div>
  );
}

/** A transcript's header: how many calls there were, and on what number. */
export function CallHead({ calls, number }: { calls: number; number: string | null }) {
  return (
    <div className="card-head calls-head">
      <h2 className="eyebrow">Call transcript</h2>
      <span className="hint">
        <Phone size={13} aria-hidden /> {calls === 1 ? '1 call' : `${calls} calls`}
        {number ? <span className="mono"> · +{number}</span> : null}
      </span>
    </div>
  );
}

/**
 * One call: when it was and how long it ran, its recording, then the turns. It
 * is a `details`, so a case with several calls folds down to the one being read
 * and none of that needs JavaScript. The download sits outside the `details`:
 * inside it, pressing it would fold the panel, and collapsing would hide it.
 */
export function CallPanel({
  index,
  of,
  startedAt,
  seconds,
  src,
  open = true,
  children,
}: {
  index: number;
  of: number;
  startedAt: Date | string | null;
  seconds: number | null;
  src: string | null;
  open?: boolean;
  children?: ReactNode;
}) {
  const length = durationLabel(seconds);
  const title = of > 1 ? `Call ${index}` : 'Call';
  return (
    <div className="call-panel">
      {src ? (
        <a className="call-panel-get" href={`${src}?download=1`} download title="Download the recording">
          <Download size={16} aria-hidden />
          <span className="sr-only">Download the recording</span>
        </a>
      ) : null}
      <details open={open}>
        <summary className="call-panel-head">
          <span className="call-panel-title">{title}</span>
          <span className="call-panel-when">{formatTime(startedAt)}</span>
          {length ? <span className="chip neutral mono">{length}</span> : null}
          <ChevronDown size={16} className="call-panel-chevron" aria-hidden />
        </summary>
        <div className="call-panel-body">
          {src ? <AudioPlayer src={src} label={`${title} · ${formatTime(startedAt)}`} /> : null}
          {children}
        </div>
      </details>
    </div>
  );
}
