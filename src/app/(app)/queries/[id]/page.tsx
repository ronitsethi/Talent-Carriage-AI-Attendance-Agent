import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { queryDetail } from '@/lib/queries';
import { feedbackLabel, formatTime } from '@/lib/display';
import { summaryIsStale } from '@/lib/conversation/summary';
import { SummaryWriter } from '@/components/summary-writer';
import { CallHead, CallPanel, ChatHead, Thread, type Entry } from '@/components/conversation';
import { CostBox } from '@/components/cost-box';
import { updateTicket, writeQuerySummary } from '@/app/actions';
import { PersonHead } from '@/components/person-head';
import { TicketForm } from '@/components/ticket-form';
import { Notice } from '@/components/notice';
import { listQueryTypes } from '@/lib/query-types';
import { assignablePeople, assignmentNote, ticketLabel, ticketLtPerson } from '@/lib/tickets';
import { ticketActivity } from '@/lib/ticket-whatsapp';

/** A line of a ticket's WhatsApp history, in words. */
const ACTIVITY: Record<string, string> = {
  assigned: 'Ticket sent',
  reminder: '36-hour reminder sent',
  escalated: 'Escalated to the LT person, sent',
  resolved: 'Resolved, thanks sent',
  which: 'Asked which ticket',
  moved: 'Told it is with somebody else, sent',
  reply: 'Reply',
};
const STATUS: Record<string, string> = {
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'not sent',
  received: 'received',
  simulated: 'dry run, not sent',
};

/** A summary's lines, one per question or answer. */
function Lines({ text }: { text: string | null }) {
  const lines = (text ?? '').split('\n').filter((line) => line.trim());
  if (!lines.length) return <>—</>;
  if (lines.length === 1) return <>{lines[0]}</>;
  return (
    <ul className="summary-list">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  );
}

export default async function QueryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { id } = await params;
  const { saved } = await searchParams;
  const detail = await queryDetail(tenantId, id);
  if (!detail) notFound();

  const { query, employee, lines, chatMessages, company, costs } = detail;
  // The ticket's choices: every query type in the sheet, and everybody on a COE team.
  const ticket = query.ticketStatus
    ? await Promise.all([listQueryTypes(), assignablePeople(), ticketLtPerson(query.assignedTeamId, query.coeCode), ticketActivity(query.id)])
    : null;
  const feedback = feedbackLabel(query);
  const onCall = query.channel === 'voice';
  const asked = lines.some((line) => line.role === 'employee');
  // A call is read as a transcript; a chat is read as the chat it was, so it
  // comes from the messages themselves, which carry the buttons and the ticks.
  const chat: Entry[] = chatMessages
    .filter((message) => message.body?.trim() || message.buttons?.length)
    .map((message) => ({
      kind: 'turn',
      key: message.id,
      at: (message.sentAt ?? message.createdAt).toISOString(),
      side: message.direction,
      body: message.body ?? '',
      options: message.buttons?.length ? message.buttons.map((b) => b.title).join(' · ') : undefined,
      note: message.kind === 'template' ? 'template' : undefined,
      state: message.status,
    }));
  const spoken: Entry[] = lines.map((line, index) => ({
    kind: 'turn',
    key: `turn-${index}`,
    at: line.at,
    side: line.role === 'agent' ? 'outbound' : 'inbound',
    body: line.heard !== undefined && line.heard.trim() ? line.heard : line.text,
    note: line.heard === undefined ? undefined : line.heard.trim() ? 'cut off' : 'not heard',
  }));
  const ranFor = query.endedAt ? Math.round((query.endedAt.getTime() - query.startedAt.getTime()) / 1000) : null;
  const stale = asked && summaryIsStale(query.summarisedAt, lines);
  const summary = (text: string | null) =>
    text ? <Lines text={text} /> : asked ? <span className="sub">Being written…</span> : <span className="sub">Nothing asked yet</span>;

  return (
    <>
      {saved ? (
        <Notice tone="ok" clear={['saved']}>
          The ticket is saved.
        </Notice>
      ) : null}
      <section className="page-head">
        <Link className="back-link" href="/queries">
          ← All queries
        </Link>
        <div className="title-row">
          <h1>{employee.fullName}</h1>
        </div>
        <p style={{ marginTop: 6 }}>
          {onCall ? `Call · ${query.callStyle === 'keypad' ? 'Keypad' : 'Talk'}` : 'WhatsApp'} · {formatTime(query.startedAt)}
        </p>
      </section>

      <div className="layout details-first">
        <aside className="stack">
          <section className="card pad">
            <PersonHead
              name={employee.fullName}
              channel={onCall ? 'voice' : 'whatsapp'}
              company={company}
              at={query.startedAt}
              code={employee.empCode}
              department={employee.department}
              mobile={employee.mobileE164}
            />
            {ticket ? (
              <>
                <div className="ticket-head">
                  <h3>
                    Ticket <span className="mono ticket-no">{ticketLabel(query.ticketNo)}</span>
                  </h3>
                  <span className={`chip ${query.ticketStatus === 'resolved' ? 'ok' : 'info'}`}>
                    {query.ticketStatus === 'resolved' ? `Resolved ${formatTime(query.resolvedAt)}` : `Open since ${formatTime(query.ticketRaisedAt)}`}
                  </span>
                </div>
                {/* Keyed on what is saved, so a save starts the form from the new values. */}
                <TicketForm
                  key={`${query.queryTypeId}-${query.priority}-${query.assignedPersonId}-${query.ltTransferredAt?.toISOString()}-${query.problemDescription?.length}`}
                  queryId={query.id}
                  initial={{
                    queryTypeId: query.queryTypeId ?? '',
                    priority: query.priority ?? 'medium',
                    description: query.problemDescription ?? '',
                    assignedPersonId: query.assignedPersonId ?? '',
                    ltTransferred: query.ltTransferredAt ? 'yes' : 'no',
                    ltPersonId: query.ltPersonId ?? ticket[2] ?? '',
                  }}
                  types={ticket[0].map((type) => ({ id: type.id, label: type.name, coe: type.coeCode }))}
                  people={ticket[1].map((person) => ({
                    id: person.id,
                    label: [person.name, person.code, person.teams.join(', ')].filter(Boolean).join(' · '),
                  }))}
                  staleType={!query.queryTypeId ? query.queryTypeName : null}
                  assignmentNote={assignmentNote(query.assignmentMark, query.coeCode)}
                  action={updateTicket}
                />
                <div className="ticket-activity">
                  <h4>On WhatsApp</h4>
                  {ticket[3].length ? (
                    <ol>
                      {ticket[3].map((line) => (
                        <li key={line.id} className={line.status === 'failed' ? 'failed' : undefined}>
                          <span className="ticket-activity-what">
                            {ACTIVITY[line.kind] ?? line.kind} {line.direction === 'inbound' ? 'from' : 'to'} {line.person ?? 'somebody since removed'}
                          </span>
                          <span className="ticket-activity-when">
                            {formatTime(line.at)} · {STATUS[line.status] ?? line.status}
                          </span>
                          {line.error ? <span className="ticket-activity-error">{line.error}</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="hint">Nothing sent yet{query.assignedPersonId ? '' : ': it goes out once somebody is assigned'}.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="hint card-rule">No ticket was raised for this query.</p>
            )}
          </section>

          <section className="card pad">
            <dl className="kv">
              <dt>Query</dt>
              <dd>{summary(query.summaryQueries)}</dd>
              <dt>Reply</dt>
              <dd>{summary(query.summaryReply)}</dd>
              {onCall ? (
                <>
                  <dt>Feedback</dt>
                  <dd>
                    {feedback ? (
                      <>
                        Question: {feedback.resolved}
                        <br />
                        Call: {feedback.rating}
                        {feedback.comment ? (
                          <>
                            <br />“{feedback.comment}”
                          </>
                        ) : null}
                      </>
                    ) : query.endedAt ? (
                      <span className="sub">Asked on WhatsApp a minute after the call</span>
                    ) : (
                      <span className="sub">Asked once the call ends</span>
                    )}
                  </dd>
                </>
              ) : null}
            </dl>
            {stale ? <SummaryWriter write={writeQuerySummary.bind(null, query.id)} hasOne={Boolean(query.summarisedAt)} /> : null}
          </section>
        </aside>

        <div className="stack">
          {onCall ? (
            <section className="card flush">
              <CallHead calls={1} number={employee.mobileE164} />
              <div className="calls-body">
                <CallPanel
                  index={1}
                  of={1}
                  startedAt={query.startedAt}
                  seconds={ranFor}
                  src={query.recordingUri ? `/api/recordings/query/${query.id}` : null}
                >
                  {!query.recordingUri && !query.endedAt ? (
                    <p className="hint">The recording appears here once the call has ended.</p>
                  ) : null}
                  <div className="chat calls">
                    <Thread entries={spoken} skin="call" name={employee.fullName} empty="Nothing has been said yet." />
                  </div>
                </CallPanel>
              </div>
            </section>
          ) : (
            <section className="card flush">
              <ChatHead name={employee.fullName} number={employee.mobileE164} />
              <div className="chat wa">
                <Thread entries={chat} skin="wa" name={employee.fullName} empty="Nothing has been said yet." />
              </div>
            </section>
          )}

          {onCall && chat.length ? (
            <section className="card flush">
              <div className="card-head">
                <h2 className="eyebrow">Feedback, asked on WhatsApp after the call</h2>
              </div>
              <div className="chat wa">
                <Thread entries={chat} skin="wa" name={employee.fullName} empty="Nothing has been sent yet." />
              </div>
            </section>
          ) : null}
          {/* What it all cost, in one card under everything else. */}
          <section className="card pad costs-card">
            <h2 className="eyebrow">Costs</h2>
            <CostBox box={costs} title="Cost of this query" at={query.startedAt} open />
          </section>
        </div>
      </div>
    </>
  );
}
