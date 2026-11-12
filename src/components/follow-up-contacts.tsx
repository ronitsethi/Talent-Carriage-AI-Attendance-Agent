'use client';

import { useState } from 'react';
import type { FollowUpContact } from '@/db/schema';

const OWN = "Employee's own setting";

/**
 * The No. of follow-ups box, and how each level reaches people. They sit together
 * so the rows follow the number as it is typed, before anything is saved.
 */
export function FollowUpContacts({ levels, saved }: { levels: number; saved: FollowUpContact[] }) {
  const [typed, setTyped] = useState(String(levels));
  const [channels, setChannels] = useState<Record<number, string>>({});
  const count = Math.min(10, Math.max(1, Math.round(Number(typed)) || 1));

  return (
    <div style={{ marginTop: 16 }}>
      <div className="field" style={{ width: 190 }}>
        <label htmlFor="maxFollowUps">No. of follow-ups</label>
        <input
          className="input"
          type="number"
          min={1}
          max={10}
          id="maxFollowUps"
          name="maxFollowUps"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
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
              const contact = saved[index];
              const channel = channels[level] ?? contact?.channel ?? '';
              return (
                <tr key={level}>
                  <td className="nowrap">
                    Follow-up {level}
                    {level === count ? <div className="sub">Final warning</div> : null}
                  </td>
                  <td>
                    <select
                      className="input"
                      name={`followUpChannel${level}`}
                      aria-label={`Follow-up ${level} contact by`}
                      value={channel}
                      onChange={(event) => setChannels({ ...channels, [level]: event.target.value })}
                    >
                      <option value="">{OWN}</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="voice">Call</option>
                    </select>
                  </td>
                  <td>
                    <select
                      className="input"
                      name={`followUpCallMode${level}`}
                      aria-label={`Follow-up ${level} call style`}
                      defaultValue={contact?.callMode ?? ''}
                      disabled={channel === 'whatsapp'}
                    >
                      <option value="">{OWN}</option>
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
      <p className="field-help" style={{ maxWidth: '70ch' }}>
        These apply to everyone at this customer, over each employee&apos;s own Contact by and Call style. Leave a level on{' '}
        {OWN.toLowerCase()} to change nothing for it.
      </p>
    </div>
  );
}
