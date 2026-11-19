import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { employees, tenants } from '@/db/schema';
import { getActiveTenantId, getSession, isPlatformAdmin } from '@/lib/auth';
import {
  inUse,
  isPromptKey,
  ORIGINAL,
  PROMPT_KEYS,
  PROMPTS,
  promptHistory,
  promptsFor,
  type PromptKey,
  type PromptVersion,
} from '@/lib/prompts';
import { answerSystem, talkingSystem } from '@/lib/prompts/build';
import { diffLines } from '@/lib/prompts/diff';
import { activatePrompt, clearPrompt, deletePrompt } from '@/app/prompt-actions';
import { ConfirmSubmit } from '@/components/confirm';
import { Notice } from '@/components/notice';
import { Pill } from '@/components/status-pill';
import { PromptEditor } from './editor';

const WHEN = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/** Which whole prompts the AI gets with this one in them. */
const USED_IN: Record<PromptKey, ('talk-call' | 'talk-chat' | 'answer-call' | 'answer-chat')[]> = {
  talking_agent: ['talk-call', 'talk-chat'],
  guideline_answerer: ['answer-call', 'answer-chat'],
  attendance: ['talk-call', 'talk-chat', 'answer-call', 'answer-chat'],
  limits: ['talk-call', 'talk-chat', 'answer-call', 'answer-chat'],
  leave: ['talk-call', 'talk-chat', 'answer-call', 'answer-chat'],
  payroll: ['talk-call', 'talk-chat', 'answer-call', 'answer-chat'],
};
const WHOLE_LABELS = {
  'talk-call': 'Talking agent on a call',
  'talk-chat': 'Talking agent on WhatsApp',
  'answer-call': 'Guideline answerer on a call',
  'answer-chat': 'Guideline answerer on WhatsApp',
} as const;

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ p?: string; view?: string; compare?: string; changed?: string; problem?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!isPlatformAdmin(session)) redirect('/');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const params = await searchParams;
  const key: PromptKey = params.p && isPromptKey(params.p) ? params.p : 'talking_agent';
  const [tenant, history, prompts, people] = await Promise.all([
    withPlatformScope((tx) => tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) })),
    withPlatformScope((tx) => promptHistory(tx, key, tenantId)),
    withTenant(tenantId, (tx) => promptsFor(tx, tenantId)),
    withTenant(tenantId, (tx) =>
      tx
        .select({ id: employees.id, name: employees.fullName, code: employees.empCode })
        .from(employees)
        .where(eq(employees.tenantId, tenantId))
        .orderBy(employees.fullName)
        .limit(200),
    ),
  ]);
  const customer = tenant?.name ?? 'this customer';
  const current = inUse(history, key);
  // The page's own reading of the history is newer than the agent's short-lived copy.
  const set = { ...prompts, [key]: current.body };
  const meta = PROMPTS[key];

  const all = [...history.everyone, ...history.own];
  const textOf = (id: string | undefined) =>
    id === 'original' ? { label: 'Original', body: ORIGINAL[key] } : all.find((v) => v.id === id) ? describeVersion(all.find((v) => v.id === id)!) : null;
  const viewing = textOf(params.view);
  const comparing = textOf(params.compare);
  const here = (extra: Record<string, string>) => `/prompts?${new URLSearchParams({ p: key, ...extra }).toString()}`;

  const inUseLabel =
    current.from === 'own'
      ? `its own version ${current.version!.number}`
      : current.from === 'everyone'
        ? `the all-customers version ${current.version!.number}`
        : 'the original';

  return (
    <>
      {params.changed ? (
        <Notice tone="ok" clear={['changed']}>
          {params.changed}
        </Notice>
      ) : null}
      {params.problem ? (
        <Notice tone="err" clear={['problem']}>
          {params.problem}
        </Notice>
      ) : null}

      <section className="page-head">
        <div className="eyebrow">Talent Carriage console</div>
        <h1>AI prompts</h1>
        <p>
          What the AI is told when it talks to employees and answers their questions, on calls and WhatsApp. A saved version is
          used straight away. Viewing <strong>{customer}</strong>: a version saved for this customer only applies to them alone.
        </p>
      </section>

      <nav className="switch-group wrap gap-below" aria-label="Which prompt">
        {PROMPT_KEYS.map((k) => (
          <Link key={k} href={`/prompts?p=${k}`} className={`switch-option ${k === key ? 'on' : ''}`} aria-current={k === key ? 'page' : undefined}>
            {PROMPTS[k].title}
          </Link>
        ))}
      </nav>

      <section className="card gap-below">
        <div className="card-head">
          <div>
            <h2>{meta.title}</h2>
            <p className="field-help" style={{ marginTop: 4 }}>
              {meta.what} Used by: {meta.usedBy}.
            </p>
          </div>
          <Pill tone={current.from === 'original' ? 'idle' : 'done'}>
            {customer} uses {inUseLabel}
          </Pill>
        </div>
        <PromptEditor key={`${key}:${current.version?.id ?? 'original'}`} prompt={key} initial={current.body} customer={customer} people={people} />
        <details className="form-section prompt-whole">
          <summary>See the whole prompt the AI gets, with the parts the system keeps fixed</summary>
          <p className="field-help">
            The opening line, how a call differs from WhatsApp, the outcomes list, how answers are recorded and the answer&apos;s
            fields are fixed by the system, because the code depends on them. Shown with what {customer} uses now.
          </p>
          {USED_IN[key].map((which) => (
            <details key={which} className="prompt-whole-one">
              <summary>{WHOLE_LABELS[which]}</summary>
              <pre className="prompt-pre">
                {which.startsWith('talk')
                  ? talkingSystem(set, which.endsWith('call') ? 'call' : 'chat')
                  : answerSystem(set, which.endsWith('call') ? 'call' : 'chat')}
              </pre>
            </details>
          ))}
        </details>
      </section>

      {viewing && !comparing ? (
        <section className="card gap-below">
          <div className="card-head">
            <h2>{viewing.label}</h2>
            <Link className="btn small" href={here({})}>
              Close
            </Link>
          </div>
          <pre className="prompt-pre form-section">{viewing.body}</pre>
        </section>
      ) : null}

      {comparing ? (
        <section className="card gap-below">
          <div className="card-head">
            <h2>
              {comparing.label} compared with what {customer} uses now
            </h2>
            <Link className="btn small" href={here({})}>
              Close
            </Link>
          </div>
          <div className="form-section">
            <p className="field-help" style={{ marginTop: 0 }}>
              <span className="diff-key removed">Only in what is used now</span> <span className="diff-key added">Only in {comparing.label}</span>
            </p>
            <Diff before={current.body} after={comparing.body} />
          </div>
        </section>
      ) : null}

      <section className="card flush gap-below">
        <div className="card-head">
          <h2>All customers</h2>
          <span className="field-help" style={{ margin: 0 }}>
            Used by every customer without a version of its own.
          </span>
        </div>
        <VersionTable
          prompt={key}
          rows={history.everyone}
          showOriginal
          originalInUse={!history.everyone.some((v) => v.active)}
          here={here}
          scope="everyone"
        />
      </section>

      <section className="card flush">
        <div className="card-head">
          <h2>Only for {customer}</h2>
          {current.from === 'own' ? (
            <form action={clearPrompt}>
              <input type="hidden" name="prompt" value={key} />
              <input type="hidden" name="scope" value="own" />
              <ConfirmSubmit
                label="Use the all-customers version again"
                className="btn small"
                title="Use the all-customers version again?"
                message={<p>{customer} stops using its own version straight away. Its versions stay here to go back to.</p>}
                confirmLabel="Use the all-customers version"
              />
            </form>
          ) : (
            <span className="field-help" style={{ margin: 0 }}>
              {customer} has no version of its own in use; it uses the all-customers one.
            </span>
          )}
        </div>
        {history.own.length ? (
          <VersionTable prompt={key} rows={history.own} here={here} scope="own" />
        ) : (
          <p className="form-section field-help" style={{ marginTop: 0 }}>
            None saved yet. Tick &quot;Use this version only for {customer}&quot; when saving to make one.
          </p>
        )}
      </section>
    </>
  );
}

function describeVersion(v: PromptVersion) {
  return { label: `Version ${v.number}${v.tenantId ? ' (this customer)' : ' (all customers)'}`, body: v.body };
}

function VersionTable({
  prompt,
  rows,
  showOriginal,
  originalInUse,
  here,
  scope,
}: {
  prompt: PromptKey;
  rows: PromptVersion[];
  showOriginal?: boolean;
  originalInUse?: boolean;
  here: (extra: Record<string, string>) => string;
  scope: 'everyone' | 'own';
}) {
  return (
    <div className="table-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>Version</th>
            <th>Saved</th>
            <th>By</th>
            <th>Note</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.id}>
              <td className="mono">{v.number}</td>
              <td>{WHEN.format(v.createdAt)}</td>
              <td>{v.createdByName ?? '—'}</td>
              <td>{v.note ?? '—'}</td>
              <td>{v.active ? <Pill tone="done">In use</Pill> : null}</td>
              <td>
                <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                  <Link className="btn small" href={here({ view: v.id })}>
                    View
                  </Link>
                  <Link className="btn small" href={here({ compare: v.id })}>
                    Compare
                  </Link>
                  {v.active ? null : (
                    <>
                      <form action={activatePrompt}>
                        <input type="hidden" name="prompt" value={prompt} />
                        <input type="hidden" name="id" value={v.id} />
                        <ConfirmSubmit
                          label="Make active"
                          className="btn small"
                          title={`Use version ${v.number} again?`}
                          message={<p>It is used straight away on calls and WhatsApp{scope === 'own' ? ' for this customer' : ' for every customer without its own version'}.</p>}
                          confirmLabel={`Use version ${v.number}`}
                        />
                      </form>
                      <form action={deletePrompt}>
                        <input type="hidden" name="prompt" value={prompt} />
                        <input type="hidden" name="id" value={v.id} />
                        <ConfirmSubmit
                          label="Delete"
                          className="btn small"
                          tone="danger"
                          title={`Delete version ${v.number}?`}
                          message={<p>It is removed for good and cannot be brought back.</p>}
                          confirmLabel="Delete it"
                        />
                      </form>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {showOriginal ? (
            <tr>
              <td className="mono">0</td>
              <td colSpan={3}>Original, as written in the system. It cannot be deleted.</td>
              <td>{originalInUse ? <Pill tone="done">In use</Pill> : null}</td>
              <td>
                <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                  <Link className="btn small" href={here({ view: 'original' })}>
                    View
                  </Link>
                  <Link className="btn small" href={here({ compare: 'original' })}>
                    Compare
                  </Link>
                  {originalInUse ? null : (
                    <form action={clearPrompt}>
                      <input type="hidden" name="prompt" value={prompt} />
                      <input type="hidden" name="scope" value="everyone" />
                      <ConfirmSubmit
                        label="Make active"
                        className="btn small"
                        title="Use the original again?"
                        message={<p>Every customer without its own version uses the original straight away.</p>}
                        confirmLabel="Use the original"
                      />
                    </form>
                  )}
                </div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  if (!lines.some((line) => line.kind !== 'same')) return <p className="field-help">They are the same.</p>;
  return (
    <pre className="prompt-pre prompt-diff">
      {lines.map((line, i) => (
        <span key={i} className={`diff-line ${line.kind}`}>
          {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
