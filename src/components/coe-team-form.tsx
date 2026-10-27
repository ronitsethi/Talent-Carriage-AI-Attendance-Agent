'use client';

import Link from 'next/link';
import { useActionState, useId, useMemo, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import type { CoeFormState } from '@/app/actions';

/**
 * Adding or editing one COE team.
 *
 * People are entered by name, employee code and WhatsApp number - no
 * invitations, because a ticket will reach them on WhatsApp, not through a
 * login. Somebody already on another team is offered by name, and picking them
 * fills in their code and number, so the same person is not entered twice under
 * two spellings.
 */

type Person = { name: string; code: string; mobile: string };
type Member = Person & { clients: string[] };
type Row = Member & { key: number };
export type TeamDraft = {
  id: string | null;
  code: string;
  fullName: string;
  members: Member[];
  fallback: Person | null;
  lt: Person | null;
};

const shown = (mobile: string) => (mobile ? `+${mobile.replace(/^\+/, '')}` : '');

function SaveButton({ editing }: { editing: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary" type="submit" disabled={pending}>
      {pending ? 'Saving…' : editing ? 'Save team' : 'Add team'}
    </button>
  );
}

export function CoeTeamForm({
  team,
  clients,
  people,
  action,
}: {
  team: TeamDraft;
  clients: { id: string; name: string }[];
  people: Person[];
  action: (state: CoeFormState, formData: FormData) => Promise<CoeFormState>;
}) {
  const [state, submit] = useActionState(action, null);
  const listId = useId();
  // Keys for member rows, so React keeps each row's inputs as rows move.
  const nextKey = useRef(Math.max(team.members.length, 1));

  const [code, setCode] = useState(team.code);
  const [fullName, setFullName] = useState(team.fullName);
  const draft = (person: Person | null): Person => ({ name: person?.name ?? '', code: person?.code ?? '', mobile: shown(person?.mobile ?? '') });
  const [members, setMembers] = useState<Row[]>(() =>
    (team.members.length ? team.members : [null]).map((m, key) => ({ ...draft(m), clients: m?.clients ?? [], key })),
  );
  const toggleClient = (rowKey: number, clientId: string, on: boolean) =>
    setMembers((rows) =>
      rows.map((r) =>
        r.key !== rowKey ? r : { ...r, clients: on ? [...new Set([...r.clients, clientId])] : r.clients.filter((id) => id !== clientId) },
      ),
    );
  const [fallback, setFallback] = useState<Person>(() => draft(team.fallback));
  const [lt, setLt] = useState<Person>(() => draft(team.lt));

  const saved = useMemo(() => new Map(people.map((p) => [p.name.trim().toLowerCase(), draft(p)])), [people]);
  // Picking a known name fills the code and number, where they are still empty.
  // Known means saved on any team, or typed on this form - a team member named
  // again as the fallback should not need their details twice.
  const withName = (person: Person, name: string): Person => {
    const key = name.trim().toLowerCase();
    const typed = [...members, fallback, lt].find((p) => p !== person && p.name.trim().toLowerCase() === key && (p.code.trim() || p.mobile.trim()));
    const known = typed ?? saved.get(key);
    return {
      name,
      code: person.code.trim() || !known ? person.code : known.code,
      mobile: person.mobile.trim() || !known ? person.mobile : known.mobile,
    };
  };

  const move = (index: number, by: -1 | 1) =>
    setMembers((rows) => {
      const to = index + by;
      if (to < 0 || to >= rows.length) return rows;
      const copy = [...rows];
      [copy[index], copy[to]] = [copy[to]!, copy[index]!];
      return copy;
    });

  const payload = JSON.stringify({
    id: team.id,
    code,
    fullName,
    members: members.map(({ name, code, mobile, clients }) => ({ name, code, mobile, clients })),
    fallback,
    lt,
  });

  return (
    <form action={submit} className="coe-form">
      <input type="hidden" name="team" value={payload} />
      <datalist id={listId}>
        {people.map((p) => (
          <option key={p.mobile} value={p.name}>
            {[p.code, shown(p.mobile)].filter(Boolean).join(' · ')}
          </option>
        ))}
      </datalist>

      {state?.errors.length ? (
        <div className="notice err inline" role="alert">
          <div className="notice-body">
            <strong>Not saved.</strong>
            <ul className="coe-errors">
              {state.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="coe-names">
        <div className="field">
          <label htmlFor="coe-code">COE code</label>
          <input
            id="coe-code"
            className="input mono coe-code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="DTE"
            maxLength={8}
            autoComplete="off"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="coe-name">COE full name</label>
          <input
            id="coe-name"
            className="input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Data Management & Tools"
            maxLength={120}
            required
          />
        </div>
      </div>

      <fieldset className="coe-section">
        <legend>Warm transfer COE team</legend>
        <p className="field-help">
          A ticket goes to whoever has the fewest open tickets among the members who look after that employee&apos;s company; on a
          tie, to whoever is higher in this list. Their WhatsApp number is how a ticket will reach them. A code or number already
          on another team is the same person — change their name here and it changes everywhere.
        </p>
        <ol className="coe-members">
          {members.map((row, index) => (
            <li key={row.key} className="coe-member">
              <span className="coe-n" aria-hidden>
                {index + 1}
              </span>
              <input
                className="input"
                aria-label={`Team member ${index + 1}, name`}
                placeholder="Name"
                list={listId}
                value={row.name}
                onChange={(e) => setMembers((rows) => rows.map((r) => (r.key === row.key ? { ...r, ...withName(r, e.target.value) } : r)))}
              />
              <input
                className="input mono coe-emp-code"
                aria-label={`Team member ${index + 1}, employee code`}
                placeholder="Employee code"
                value={row.code}
                onChange={(e) => setMembers((rows) => rows.map((r) => (r.key === row.key ? { ...r, code: e.target.value } : r)))}
              />
              <input
                className="input mono"
                aria-label={`Team member ${index + 1}, WhatsApp number`}
                placeholder="+91 98765 43210"
                inputMode="tel"
                value={row.mobile}
                onChange={(e) => setMembers((rows) => rows.map((r) => (r.key === row.key ? { ...r, mobile: e.target.value } : r)))}
              />
              <div className="coe-member-clients">
                <span className="coe-member-clients-label">Looks after</span>
                {clients.length ? (
                  clients.map((client) => (
                    <label key={client.id} className="pick-chip small">
                      <input
                        type="checkbox"
                        checked={row.clients.includes(client.id)}
                        onChange={(e) => toggleClient(row.key, client.id, e.target.checked)}
                      />
                      {client.name}
                    </label>
                  ))
                ) : (
                  <span className="hint">There are no customers yet.</span>
                )}
              </div>
              <div className="coe-member-tools">
                <button type="button" className="btn small quiet icon" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${row.name || `member ${index + 1}`} up`}>
                  <ArrowUp size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn small quiet icon"
                  onClick={() => move(index, 1)}
                  disabled={index === members.length - 1}
                  aria-label={`Move ${row.name || `member ${index + 1}`} down`}
                >
                  <ArrowDown size={16} aria-hidden />
                </button>
                <button
                  type="button"
                  className="btn small quiet icon"
                  onClick={() => setMembers((rows) => rows.filter((r) => r.key !== row.key))}
                  disabled={members.length === 1}
                  aria-label={`Remove ${row.name || `member ${index + 1}`}`}
                >
                  <X size={16} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className="btn small dashed" onClick={() => {
            const key = nextKey.current++;
            setMembers((rows) => [...rows, { name: '', code: '', mobile: '', clients: [], key }]);
          }}
        >
          <Plus size={16} aria-hidden /> Add member
        </button>
      </fieldset>

      <div className="coe-pair">
        {(
          [
            ['fallback', 'Warm transfer fallback person', 'Takes it when nobody on the team does.', fallback, setFallback],
            ['lt', 'LT person', 'The leadership-team owner it escalates to.', lt, setLt],
          ] as const
        ).map(([key, title, help, value, set]) => (
          <fieldset key={key} className="coe-section">
            <legend>{title}</legend>
            <p className="field-help">{help}</p>
            <div className="coe-person-inputs">
              <input
                className="input"
                aria-label={`${title}, name`}
                placeholder="Name"
                list={listId}
                value={value.name}
                onChange={(e) => set(withName(value, e.target.value))}
              />
              <input
                className="input mono coe-emp-code"
                aria-label={`${title}, employee code`}
                placeholder="Employee code"
                value={value.code}
                onChange={(e) => set({ ...value, code: e.target.value })}
              />
              <input
                className="input mono"
                aria-label={`${title}, WhatsApp number`}
                placeholder="+91 98765 43210"
                inputMode="tel"
                value={value.mobile}
                onChange={(e) => set({ ...value, mobile: e.target.value })}
              />
            </div>
          </fieldset>
        ))}
      </div>

      <div className="btn-row card-rule">
        <SaveButton editing={Boolean(team.id)} />
        <Link className="btn" href="/coe">
          Cancel
        </Link>
      </div>
    </form>
  );
}
