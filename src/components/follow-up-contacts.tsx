'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { defaultLevelContact, type LevelKind, type LevelSettings } from '@/lib/level-contacts';

const TEXT: Record<LevelKind, { count: string; countName: string; min: number; help: string; row: string; last: string; prefix: string }> = {
  reminder: {
    count: 'Number of reminders',
    countName: 'remindersBeforeEscalation',
    min: 0,
    help: 'How many reminders an unanswered date gets before it goes to the manager.',
    row: 'Reminder',
    last: 'Last warning',
    prefix: 'reminderRow',
  },
  follow_up: {
    count: 'No. of follow-ups',
    countName: 'maxFollowUps',
    min: 1,
    help: 'How many follow-ups before the final notice and the manager.',
    row: 'Follow-up',
    last: 'Final notice',
    prefix: 'followUpRow',
  },
};

/**
 * The number of reminders or follow-ups - in one line with any boxes passed as
 * `children` - and one row per level: WhatsApp or a call, and the call style.
 * The rows are folded away under a line saying which levels are calls, and
 * follow the number as it is typed, before anything is saved; a level never
 * saved shows its default. Folded rows are still sent with the form.
 */
export function LevelContacts({ kind, settings, children }: { kind: LevelKind; settings: LevelSettings; children?: ReactNode }) {
  const text = TEXT[kind];
  const saved = kind === 'reminder' ? settings.reminderContacts : settings.followUpContacts;
  const savedCount = kind === 'reminder' ? settings.remindersBeforeEscalation : settings.maxFollowUps;
  const [typed, setTyped] = useState(String(savedCount));
  const [channels, setChannels] = useState<Record<number, string>>({});
  const count = Math.min(10, Math.max(text.min, Math.round(Number(typed)) || 0));
  const levels = Array.from({ length: count }, (_, index) => index + 1);
  const channelOf = (level: number) =>
    channels[level] ?? saved[level - 1]?.channel ?? defaultLevelContact(settings, kind, level, count).channel;
  const calls = levels.filter((level) => channelOf(level) === 'voice');

  return (
    <>
      <div className="settings-grid">
        {children}
        <div className="field">
          <label htmlFor={text.countName}>{text.count}</label>
          <input
            className="input"
            type="number"
            min={text.min}
            max={10}
            id={text.countName}
            name={text.countName}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <p className="field-help">{text.help}</p>
        </div>
      </div>
      {count > 0 ? (
        <details className="fold" style={{ marginTop: 16 }}>
          <summary className="fold-head">
            <span className="fold-title">Contact by and call style, per {text.row.toLowerCase()}</span>
            <span className="fold-note">
              {calls.length ? `Calls at ${text.row} ${calls.join(', ')}` : 'All on WhatsApp'}
            </span>
            <ChevronDown size={16} className="fold-chevron" aria-hidden />
          </summary>
          <div className="fold-body table-scroll">
          <table className="data small">
            <thead>
              <tr>
                <th>Level</th>
                <th>Contact by</th>
                <th>Call style</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => {
                const fallback = defaultLevelContact(settings, kind, level, count);
                const row = saved[level - 1];
                const channel = channelOf(level);
                return (
                  <tr key={level}>
                    <td className="nowrap">
                      {text.row} {level}
                      {level === count ? <div className="sub">{text.last}</div> : null}
                    </td>
                    <td>
                      <select
                        className="input"
                        name={`${text.prefix}Channel${level}`}
                        aria-label={`${text.row} ${level} contact by`}
                        value={channel}
                        onChange={(event) => setChannels({ ...channels, [level]: event.target.value })}
                      >
                        <option value="whatsapp">WhatsApp</option>
                        <option value="voice">Call</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="input"
                        name={`${text.prefix}Style${level}`}
                        aria-label={`${text.row} ${level} call style`}
                        defaultValue={row?.callMode ?? fallback.callMode}
                        disabled={channel !== 'voice'}
                      >
                        <option value="keypad">Keypad</option>
                        <option value="agent">Talk</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </details>
      ) : null}
    </>
  );
}
