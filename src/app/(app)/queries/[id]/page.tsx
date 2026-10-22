import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { queryDetail } from '@/lib/queries';
import { feedbackLabel, formatTime } from '@/lib/display';
import { summaryIsStale } from '@/lib/conversation/summary';
import { SummaryWriter } from '@/components/summary-writer';
import { AudioPlayer } from '@/components/audio-player';
import { writeQuerySummary } from '@/app/actions';

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

export default async function QueryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { id } = await params;
  const detail = await queryDetail(tenantId, id);
  if (!detail) notFound();

  const { query, employee, manager, lines, feedbackMessages } = detail;
  const feedback = feedbackLabel(query);
  const onCall = query.channel === 'voice';
  const asked = lines.some((line) => line.role === 'employee');
  const stale = asked && summaryIsStale(query.summarisedAt, lines);
  const summary = (text: string | null) =>
    text ? <Lines text={text} /> : asked ? <span className="sub">Being written…</span> : <span className="sub">Nothing asked yet</span>;

  return (
    <>
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
            <div className="section-head">
              <h2>Query</h2>
            </div>
            <dl className="kv">
              <dt>Employee</dt>
              <dd>
                {employee.fullName} ({employee.empCode})
              </dd>
              <dt>Department</dt>
              <dd>{employee.department ?? '—'}</dd>
              <dt>Manager</dt>
              <dd>{manager ? manager.fullName : 'Not mapped'}</dd>
              <dt>Contact by</dt>
              <dd>{onCall ? 'Call' : 'WhatsApp'}</dd>
              <dt>Asked</dt>
              <dd>{formatTime(query.startedAt)}</dd>
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

        <section className="card flush">
          <div className="card-head">
            <h2>Conversation</h2>
            <span className="hint mono">
              {onCall ? 'On the phone · ' : ''}
              {employee.mobileE164 ? `+${employee.mobileE164}` : 'No number on record'}
            </span>
          </div>
          {onCall && query.recordingUri ? (
            <div className="recordings">
              <AudioPlayer src={`/api/recordings/query/${query.id}`} label={`Call · ${formatTime(query.startedAt)}`} />
            </div>
          ) : onCall && !query.endedAt ? (
            <div className="recordings">
              <span className="hint">The recording appears here once the call has ended.</span>
            </div>
          ) : null}
          <div className="chat">
            {/* Reversed inside a column-reverse box: reads in order, opens at the newest. */}
            {feedbackMessages.length
              ? [...feedbackMessages].reverse().map((message) => (
                  <div key={message.id} className={`bubble ${message.direction}`}>
                    {message.body}
                    {message.buttons?.length ? <span className="options">{message.buttons.map((b) => b.title).join(' · ')}</span> : null}
                    <span className="meta">
                      WhatsApp · {formatTime(message.sentAt ?? message.createdAt)} · {message.kind}
                    </span>
                  </div>
                ))
              : null}
            {feedbackMessages.length ? (
              <div className="chat-divider">
                <span>Feedback on WhatsApp</span>
              </div>
            ) : null}
            {lines.length ? (
              [...lines].reverse().map((line, index) => (
                <div key={index} className={`bubble ${line.role === 'agent' ? 'outbound' : 'inbound'}`}>
                  {line.heard !== undefined && line.heard.trim() ? line.heard : line.text}
                  <span className="meta">
                    {line.role === 'agent' ? (onCall ? 'agent, on the call' : 'agent') : 'employee'} · {formatTime(line.at)}
                    {line.heard !== undefined ? (line.heard.trim() ? ' · cut off' : ' · not heard') : ''}
                  </span>
                </div>
              ))
            ) : (
              <div className="chat-empty">Nothing has been said yet.</div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
