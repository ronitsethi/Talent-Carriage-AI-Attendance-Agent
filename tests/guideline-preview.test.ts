import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Previewing a guideline: the uploaded PDF is kept, served only to somebody
 * signed in to its customer, and removed with the document. A document added
 * before files were kept previews as the text the agent reads. Storage is an
 * in-memory stand-in; every value is made up.
 */

const session = {
  userId: null as unknown as string,
  email: 'hr@talentcarriage.test',
  name: 'HR Admin',
  role: 'platform_admin' as const,
  tenantId: null,
  departmentScope: [],
};
let activeTenantId = '';
const stored = new Map<string, { data: Buffer; type: string }>();

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session,
  getActiveTenantId: async () => activeTenantId,
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge')>()),
  // Reading the PDF is not what is tested here.
  ingestDocument: async () => {},
}));
vi.mock('@/lib/recordings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/recordings')>()),
  recordingsConfigured: () => true,
  saveFile: async (path: string, data: Buffer, type: string) => void stored.set(path, { data, type }),
  readFile: async (path: string) => {
    const file = stored.get(path);
    if (!file) throw new Error('no such blob');
    return { body: new Blob([new Uint8Array(file.data)]).stream(), size: file.data.length, contentType: file.type };
  },
  deleteFile: async (path: string) => void stored.delete(path),
}));

const { eq } = await import('drizzle-orm');
const { withTenant } = await import('@/db');
const { policyDocuments } = await import('@/db/schema');
const { uploadPolicyDocument, deletePolicyDocument } = await import('@/app/actions');
const { GET } = await import('@/app/api/guidelines/[id]/route');
const { makeScenario } = await import('./helpers/scenario');

type Scenario = Awaited<ReturnType<typeof makeScenario>>;
const scenarios: Scenario[] = [];
afterEach(async () => {
  for (const s of scenarios.splice(0)) await s.cleanup();
  stored.clear();
});

const PDF = Buffer.from('%PDF-1.4\n% made-up test document\n%%EOF\n');
const get = (id: string, query = '') => GET(new Request(`http://localhost/api/guidelines/${id}${query}`), { params: Promise.resolve({ id }) });

async function customer() {
  const scenario = await makeScenario();
  scenarios.push(scenario);
  return scenario;
}

async function upload(tenantId: string) {
  activeTenantId = tenantId;
  const form = new FormData();
  form.set('title', 'Leave rules');
  form.set('topic', 'leave');
  form.set('file', new File([new Uint8Array(PDF)], 'leave-rules.pdf', { type: 'application/pdf' }));
  await uploadPolicyDocument(form);
  const [doc] = await withTenant(tenantId, (tx) => tx.select().from(policyDocuments).where(eq(policyDocuments.tenantId, tenantId)));
  return doc!;
}

describe('previewing a guideline', () => {
  it('keeps the uploaded PDF and shows it inline, as uploaded', async () => {
    const { tenantId } = await customer();
    const doc = await upload(tenantId);
    expect(doc.filePath).toBe(`guidelines/${doc.id}.pdf`);

    const response = await get(doc.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="leave-rules.pdf"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("never serves another customer's document", async () => {
    const { tenantId } = await customer();
    const doc = await upload(tenantId);
    const other = await customer();
    activeTenantId = other.tenantId;
    expect((await get(doc.id)).status).toBe(404);
    expect((await get(doc.id, '?text')).status).toBe(404);
  });

  it('shows the text the agent reads for a document added before files were kept', async () => {
    const { tenantId } = await customer();
    activeTenantId = tenantId;
    const [doc] = await withTenant(tenantId, (tx) =>
      tx.insert(policyDocuments).values({ tenantId, title: 'Old rules', filename: 'old.pdf', status: 'ready', content: 'Leave must be applied within 3 days.' }).returning(),
    );
    expect((await get(doc!.id)).status).toBe(404);
    const text = await get(doc!.id, '?text');
    expect(text.headers.get('content-type')).toContain('text/plain');
    expect(await text.text()).toBe('Leave must be applied within 3 days.');
  });

  it('removes the stored PDF with the document', async () => {
    const { tenantId } = await customer();
    const doc = await upload(tenantId);
    expect(stored.has(doc.filePath!)).toBe(true);
    const form = new FormData();
    form.set('id', doc.id);
    await deletePolicyDocument(form);
    expect(stored.has(doc.filePath!)).toBe(false);
    expect((await get(doc.id)).status).toBe(404);
  });
});
