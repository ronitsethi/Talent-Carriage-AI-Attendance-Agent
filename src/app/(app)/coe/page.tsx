import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download, Pencil } from 'lucide-react';
import { getSession, isPlatformAdmin } from '@/lib/auth';
import { listClients, listPeople, listTeams, type TeamRow } from '@/lib/coe';
import { removeCoeTeam, saveCoeTeam, uploadQueryTypeSheet } from '@/app/actions';
import { QueryTypeUpload } from '@/components/query-type-upload';
import { listQueryTypes } from '@/lib/query-types';
import { Notice } from '@/components/notice';
import { ConfirmSubmit } from '@/components/confirm';
import { CoeTeamForm, type TeamDraft } from '@/components/coe-team-form';

const EMPTY: TeamDraft = { id: null, code: '', fullName: '', members: [], fallback: null, lt: null };

/** A person in the table: their name, code, and the number a ticket will reach them on. */
function Person({ person, tone }: { person: TeamRow['fallback']; tone: 'fallback' | 'lt' }) {
  if (!person) return <span className="sub">Not set</span>;
  return (
    <>
      <div className={`coe-person ${tone}`}>{person.name}</div>
      <div className="sub mono nowrap">{[person.code, `+${person.mobile}`].filter(Boolean).join(' · ')}</div>
    </>
  );
}

export default async function CoeTeamsPage({ searchParams }: { searchParams: Promise<{ team?: string; saved?: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!isPlatformAdmin(session)) redirect('/');

  const { team: editing, saved } = await searchParams;
  const [teams, clients, people, types] = await Promise.all([listTeams(), listClients(), listPeople(), listQueryTypes()]);
  const codes = new Set(teams.map((team) => team.code));

  const current = editing === 'new' ? null : teams.find((team) => team.id === editing);
  const draft: TeamDraft | null =
    editing === 'new'
      ? EMPTY
      : current
        ? {
            id: current.id,
            code: current.code,
            fullName: current.fullName,
            members: current.members.map((m) => ({ ...m, clients: m.clients.map((c) => c.id) })),
            fallback: current.fallback,
            lt: current.lt,
          }
        : null;

  return (
    <>
      {saved ? (
        <Notice tone="ok" clear={['saved']}>
          {saved} is saved.
        </Notice>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">Talent Carriage console</div>
        <h1>COE Teams</h1>
        <p>
          Who an employee&apos;s ticket is handed to: the warm transfer team in the order they are tried, who takes it when nobody
          does, and who it escalates to. Tickets will reach them on WhatsApp, on the numbers entered here.
        </p>
      </section>

      <section className="card flush gap-below">
        <div className="card-head">
          <h2>Teams ({teams.length})</h2>
          {draft ? null : (
            <Link className="btn small primary" href="/coe?team=new">
              Add team
            </Link>
          )}
        </div>
        {teams.length ? (
          <div className="table-scroll">
            <table className="data coe-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>COE code</th>
                  <th>COE full name</th>
                  <th>Warm transfer COE team</th>
                  <th>Warm transfer fallback person</th>
                  <th>LT person</th>
                  <th className="end">Action</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((team, index) => (
                  <tr key={team.id} className={team.id === editing ? 'coe-editing' : undefined}>
                    <td className="num">{index + 1}</td>
                    <td className="mono coe-code">{team.code}</td>
                    <td>
                      <div className="employee">{team.fullName}</div>
                      <div className="sub">{team.clients.length ? team.clients.map((c) => c.name).join(', ') : 'No clients yet'}</div>
                    </td>
                    <td>
                      <ol className="coe-chips">
                        {team.members.map((member, position) => (
                          <li
                            key={member.mobile}
                            className={`coe-chip${member.clients.length ? '' : ' idle'}`}
                            title={[
                              [member.code, `+${member.mobile}`].filter(Boolean).join(' · '),
                              member.clients.length
                                ? `Looks after ${member.clients.map((c) => c.name).join(', ')}`
                                : 'Looks after no company yet, so gets no tickets',
                            ].join('\n')}
                          >
                            <span className="coe-n" aria-hidden>
                              {position + 1}
                            </span>
                            {member.name}
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td>
                      <Person person={team.fallback} tone="fallback" />
                    </td>
                    <td>
                      <Person person={team.lt} tone="lt" />
                    </td>
                    <td className="end">
                      <div className="coe-actions">
                        <Link className="btn small quiet icon" href={`/coe?team=${team.id}`} aria-label={`Edit ${team.code}`} title="Edit">
                          <Pencil size={16} aria-hidden />
                        </Link>
                        <form action={removeCoeTeam}>
                          <input type="hidden" name="id" value={team.id} />
                          <ConfirmSubmit
                            label="Remove"
                            className="btn small quiet"
                            title={`Remove ${team.code}?`}
                            message={
                              <p>
                                <strong>{team.fullName}</strong> and its warm transfer order go. Anybody on no other team is
                                forgotten with it.
                              </p>
                            }
                            confirmLabel="Remove team"
                            tone="danger"
                          />
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            No COE teams yet. <Link href="/coe?team=new">Add the first one</Link>.
          </div>
        )}
      </section>

      {draft ? (
        <section className="card pad" id="team-form">
          <div className="section-head">
            <h2>{draft.id ? `Edit ${draft.code}` : 'Add a team'}</h2>
          </div>
          {/* Keyed, so opening another team starts its form afresh. */}
          <CoeTeamForm key={draft.id ?? 'new'} team={draft} clients={clients} people={people} action={saveCoeTeam} />
        </section>
      ) : editing ? (
        <div className="notice info plain">
          <div className="notice-body">That team no longer exists.</div>
        </div>
      ) : null}

      <section className="card pad gap-below">
        <div className="section-head">
          <h2>Upload the training sheet</h2>
          <a className="btn small" href="/api/coe/sheet-template" download>
            <Download size={16} aria-hidden /> Download a sample sheet
          </a>
        </div>
        <p className="card-desc">
          Replaces the query types below with the sheet&apos;s. Columns are found by their headings - COE and Type of Query are
          needed; description, keywords, trigger criteria, required info, clarifying questions and routing are read when present.
          A type whose name stays the same keeps its tickets.
        </p>
        <QueryTypeUpload action={uploadQueryTypeSheet} />
      </section>

      <section className="card flush" id="query-types">
        <div className="card-head">
          <h2>Query types ({types.length})</h2>
          <span className="hint">Each one goes to the team with its COE code.</span>
        </div>
        {types.length ? (
          <div className="table-scroll">
            <table className="data small coe-types">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>COE</th>
                  <th>Type of query</th>
                  <th>Cluster</th>
                  <th>Keywords &amp; trigger phrases</th>
                </tr>
              </thead>
              <tbody>
                {types.map((type) => (
                  <tr key={type.id}>
                    <td className="num">{type.position}</td>
                    <td className="mono coe-code">
                      {type.coeCode}
                      {codes.has(type.coeCode) ? null : (
                        <div className="sub coe-missing" title="Tickets of this type go to whichever team looks after the company, marked as such">
                          No team yet
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="employee">{type.name}</div>
                      {type.description ? <div className="sub coe-type-desc">{type.description}</div> : null}
                    </td>
                    <td className="nowrap">{type.cluster ?? '—'}</td>
                    <td>
                      <div className="coe-keywords">{type.keywords ?? '—'}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No query types yet. Upload the training sheet above.</div>
        )}
      </section>
    </>
  );
}
