'use client';

import { useState } from 'react';
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
 * The number of reminders or follow-ups, and one row per level: WhatsApp or a
 * call, and the call style. The rows follow the number as it is typed, before
 * anything is saved; a level never saved shows its default.
 */
export function LevelContacts({ kind, settings }: { kind: LevelKind; settings: LevelSettings }) {
  const text = TEXT[kind];
  const saved = kind === 'reminder' ? settings.reminderContacts : settings.followUpContacts;
  const levels = kind === 'reminder' ? settings.remindersBeforeEscalation : settings.maxFollowUps;
  const [typed, setTyped] = useState(String(levels));
  const [channels, setChannels] = useState<Record<number, string>>({});
  const count = Math.min(10, Math.max(text.min, Math.round(Number(typed)) || 0));

  return (
    <div style={{ marginTop: 16 }}>
      <div className="field" style={{ width: 220 }}>
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
      {count > 0 ? (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="data small">
            <thead>
              <tr>
                <th>Level</th>
                <th>Contact by</th>
                <th>Call style</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: count }, (_, index) => {
                const level = index + 1;
                const fallback = defaultLevelContact(settings, kind, level, count);
                const row = saved[index];
                const channel = channels[level] ?? row?.channel ?? fallback.channel;
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
      ) : null}
    </div>
  );
}
