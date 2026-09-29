import { redirect } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { policyDocuments } from '@/db/schema';
import { getActiveTenantId, getSession } from '@/lib/auth';
import { formatTime } from '@/lib/display';
import { askPolicyQuestion, deletePolicyDocument, uploadPolicyDocument } from '@/app/actions';

const TOPICS = ['attendance', 'leave', 'overtime', 'exit', 'other'];

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; a?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const [docs, { q, a }] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx.select().from(policyDocuments).where(eq(policyDocuments.tenantId, tenantId)).orderBy(desc(policyDocuments.createdAt)),
    ),
    searchParams,
  ]);
  const ready = docs.filter((d) => d.status === 'ready').length;

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">◆ What the agent knows</div>
        <h1>Guidelines the agent can answer from</h1>
        <p>
          Their own policy documents. The agent answers questions from these and from the caller&apos;s own attendance,
          and says it will refer to HR when the answer is not here — it never fills a gap with a guess.
        </p>
      </section>

      {q ? (
        <div className={`notice ${a ? 'ok' : 'err'}`} style={{ margin: '16px 0 0' }}>
          <strong>{q}</strong>
          <div style={{ marginTop: 6, fontWeight: 400 }}>{a}</div>
        </div>
      ) : null}

      <div className="layout" style={{ marginTop: 16 }}>
        <div>
          <section className="card pad">
            <div className="section-head">
              <h2>Documents</h2>
              <span className="hint">{ready} ready of {docs.length}</span>
            </div>
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th style={{ width: 110 }}>Topic</th>
                    <th style={{ width: 150 }}>State</th>
                    <th style={{ width: 90 }} />
                  </tr>
                </thead>
                <tbody>
                  {docs.length ? (
                    docs.map((doc) => (
                      <tr key={doc.id}>
                        <td>
                          {doc.title}
                          <div className="sub">
                            {doc.filename} · {formatTime(doc.createdAt)}
                          </div>
                        </td>
                        <td>
                          <span className="pill idle">{doc.topic}</span>
                        </td>
                        <td>
                          {doc.status === 'ready' ? (
                            <span className="pill done">{doc.pageCount} passages</span>
                          ) : doc.status === 'failed' ? (
                            <>
                              <span className="pill danger">Could not be read</span>
                              <div className="sub">{doc.error}</div>
                            </>
                          ) : (
                            <span className="pill waiting">Reading…</span>
                          )}
                        </td>
                        <td>
                          <form action={deletePolicyDocument}>
                            <input type="hidden" name="id" value={doc.id} />
                            <button className="btn small" type="submit">
                              Remove
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="empty" colSpan={4}>
                        No guidelines yet. Until one is added, every question goes to HR.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card pad" style={{ marginTop: 16 }}>
            <div className="section-head">
              <h2>Try a question</h2>
            </div>
            <p className="hint" style={{ marginBottom: 12 }}>
              Exactly what the agent would say on a call. Worth checking a few before letting it answer anybody.
            </p>
            <form action={askPolicyQuestion} className="row" style={{ padding: 0 }}>
              <div className="field" style={{ flex: 1, minWidth: 260 }}>
                <label htmlFor="question">Question</label>
                <input
                  className="input"
                  id="question"
                  name="question"
                  defaultValue={q ?? ''}
                  placeholder="How much notice do I have to give when resigning?"
                />
              </div>
              <button className="btn primary" type="submit" style={{ alignSelf: 'end' }}>
                Ask
              </button>
            </form>
          </section>
        </div>

        <aside>
          <section className="card pad">
            <div className="section-head">
              <h2>Add a guideline</h2>
            </div>
            <p className="hint" style={{ marginBottom: 12 }}>
              A PDF. Scanned documents are fine — they are read as images, which takes a few seconds longer.
            </p>
            <form action={uploadPolicyDocument}>
              <div className="field">
                <label htmlFor="title">Title</label>
                <input className="input" id="title" name="title" placeholder="Leave guidelines" />
              </div>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="topic">Topic</label>
                <select className="input" id="topic" name="topic" defaultValue="other">
                  {TOPICS.map((topic) => (
                    <option key={topic} value={topic}>
                      {topic}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="file">File</label>
                <input className="input" type="file" id="file" name="file" accept=".pdf" required />
              </div>
              <button className="btn primary" type="submit" style={{ marginTop: 12 }}>
                Add and read it
              </button>
            </form>
          </section>
        </aside>
      </div>
    </>
  );
}
