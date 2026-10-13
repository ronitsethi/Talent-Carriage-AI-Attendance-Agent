import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { employees, policyDocuments } from '@/db/schema';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { formatTime } from '@/lib/display';
import { FileDrop } from '@/components/file-drop';
import { Pill } from '@/components/status-pill';
import { askPolicyQuestion, deletePolicyDocument, uploadPolicyDocument } from '@/app/actions';
import { RefreshWhileReading } from './refresh';

const TOPICS = ['attendance', 'leave', 'overtime', 'exit', 'other'];

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; a?: string; who?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const [docs, staff, { q, a, who }] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx.select().from(policyDocuments).where(eq(policyDocuments.tenantId, tenantId)).orderBy(desc(policyDocuments.createdAt)),
    ),
    withTenant(tenantId, (tx) =>
      tx
        .select({ id: employees.id, name: employees.fullName, code: employees.empCode })
        .from(employees)
        .where(eq(employees.tenantId, tenantId))
        .orderBy(employees.fullName)
        .limit(200),
    ),
    searchParams,
  ]);
  const ready = docs.filter((d) => d.status === 'ready').length;

  return (
    <>
      <RefreshWhileReading active={docs.some((d) => d.status === 'processing')} />
      <section className="page-head">
        <div className="eyebrow">What the agent knows</div>
        <h1>Guidelines the agent can answer from</h1>
        <p>
          Their own policy documents. The agent answers questions from these and from the caller&apos;s own attendance,
          and says it will refer to HR when the answer is not here — it never fills a gap with a guess.
        </p>
      </section>

      <div className="layout">
        <div className="stack">
          <section className="card pad">
            <div className="section-head">
              <h2>Try a question</h2>
            </div>
            <p className="card-desc">
              Exactly what the agent would say on a call. Asking as somebody lets you check the answers about their own
              attendance, which is what a caller is identified as by their number.
            </p>
            <form action={askPolicyQuestion} className="row">
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="employeeId">Asking as</label>
                <select className="input lg" id="employeeId" name="employeeId" defaultValue={who ?? ''}>
                  <option value="">Nobody — policy questions only</option>
                  {staff.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} · {person.code}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 240 }}>
                <label htmlFor="question">Question</label>
                <input
                  className="input lg"
                  id="question"
                  name="question"
                  defaultValue={q ?? ''}
                  placeholder="How much notice do I have to give when resigning?"
                />
              </div>
              <button className="btn primary lg" type="submit">
                Ask
              </button>
            </form>

            {q ? (
              <div className={`answer${a ? '' : ' err'}`} role="status">
                <div className="answer-q">{q}</div>
                {a ? <div className="answer-a">{a}</div> : null}
              </div>
            ) : null}
          </section>

          <section className="card flush">
            <div className="card-head">
              <h2>Documents</h2>
              <span className="hint">
                {ready} ready of {docs.length}
              </span>
            </div>
            {docs.length ? (
              docs.map((doc) => (
                <div key={doc.id} className="doc-row">
                  <div className="doc-glyph" aria-hidden>
                    PDF
                  </div>
                  <div className="doc-main">
                    <div className="doc-title">{doc.title}</div>
                    <div className="hint">
                      {doc.filename} · {formatTime(doc.createdAt)}
                    </div>
                    {doc.status === 'failed' && doc.error ? <div className="hint">{doc.error}</div> : null}
                  </div>
                  <span className="chip neutral">{doc.topic}</span>
                  {doc.status === 'ready' ? (
                    <Pill tone="done">{doc.pageCount} passages</Pill>
                  ) : doc.status === 'failed' ? (
                    <Pill tone="call">Could not be read</Pill>
                  ) : (
                    <Pill tone="waiting">Reading…</Pill>
                  )}
                  <form action={deletePolicyDocument}>
                    <input type="hidden" name="id" value={doc.id} />
                    <button className="btn small quiet" type="submit" aria-label={`Remove ${doc.title}`}>
                      Remove
                    </button>
                  </form>
                </div>
              ))
            ) : (
              <div className="empty">No guidelines yet. Until one is added, every question goes to HR.</div>
            )}
          </section>
        </div>

        <section className="card pad">
          <div className="section-head">
            <h2>Add a guideline</h2>
          </div>
          <p className="card-desc">
            A PDF. Scanned documents are fine — they are read as images, which takes a few seconds longer.
          </p>
          <form action={uploadPolicyDocument} className="fields">
            <div className="field">
              <label htmlFor="title">Title</label>
              <input className="input lg" id="title" name="title" placeholder="Leave guidelines" />
            </div>
            <div className="field">
              <label htmlFor="topic">Topic</label>
              <select className="input lg" id="topic" name="topic" defaultValue="other">
                {TOPICS.map((topic) => (
                  <option key={topic} value={topic}>
                    {topic}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="file">File</label>
              <FileDrop id="file" name="file" accept=".pdf" hint=".pdf" label="Choose a PDF" required tall />
            </div>
            <button className="btn primary lg block" type="submit">
              Add and read it
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
