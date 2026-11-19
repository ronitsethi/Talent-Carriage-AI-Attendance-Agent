'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { employees, tenants, tenantSettings } from '@/db/schema';
import { getActiveTenantId, getSession, isPlatformAdmin } from '@/lib/auth';
import { answerQuestion } from '@/lib/knowledge';
import { previewCallReply } from '@/lib/conversation/talk';
import {
  activatePromptVersion,
  clearActivePrompt,
  deletePromptVersion,
  isPromptKey,
  MAX_PROMPT_LENGTH,
  PROMPTS,
  PromptRefused,
  promptsFor,
  savePromptVersion,
  type PromptKey,
} from '@/lib/prompts';

/*
 * The AI prompts page. Talent Carriage staff only: a saved version is used at
 * once on calls and WhatsApp, for every customer unless it is saved for the
 * customer being viewed alone.
 */

async function requireStaff() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!isPlatformAdmin(session)) throw new Error('Only Talent Carriage staff can change the AI prompts');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) throw new Error('No customer selected');
  const tenant = await withPlatformScope((tx) => tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }));
  return { session, tenantId, customer: tenant?.name ?? 'this customer' };
}

function readPrompt(formData: FormData): PromptKey {
  const prompt = String(formData.get('prompt') ?? '');
  if (!isPromptKey(prompt)) throw new Error('Unknown prompt');
  return prompt;
}

/** Back to the page, saying how it went. */
function done(prompt: PromptKey, outcome: { changed: string } | { problem: string }): never {
  revalidatePath('/prompts');
  const params = new URLSearchParams({ p: prompt, ...outcome });
  redirect(`/prompts?${params.toString()}`);
}

/** Saves the text as a new version and starts using it. */
export async function savePrompt(formData: FormData) {
  const { session, tenantId, customer } = await requireStaff();
  const prompt = readPrompt(formData);
  const onlyThis = formData.get('onlyThisCustomer') === 'on';

  let saved: { number: number } | null = null;
  let problem: string | null = null;
  try {
    saved = await withPlatformScope((tx) =>
      savePromptVersion(tx, {
        prompt,
        tenantId: onlyThis ? tenantId : null,
        body: String(formData.get('body') ?? ''),
        note: String(formData.get('note') ?? ''),
        userId: session.userId,
        userName: session.name,
      }),
    );
  } catch (error) {
    if (!(error instanceof PromptRefused)) throw error;
    problem = error.message;
  }
  if (!saved) done(prompt, { problem: problem ?? 'Could not save.' });
  done(prompt, {
    changed: `${PROMPTS[prompt].title} version ${saved.number} is saved and in use ${onlyThis ? `for ${customer} only` : 'for every customer'}.`,
  });
}

/** Goes back to a saved version: it is in use again for its own scope. */
export async function activatePrompt(formData: FormData) {
  const { tenantId, customer } = await requireStaff();
  const prompt = readPrompt(formData);
  let message: string;
  try {
    const version = await withPlatformScope(async (tx) => {
      const found = await tx.query.promptVersions.findFirst({ where: (v, { eq: is }) => is(v.id, String(formData.get('id') ?? '')) });
      if (found?.tenantId && found.tenantId !== tenantId) throw new PromptRefused('That version belongs to another customer.');
      return activatePromptVersion(tx, String(formData.get('id') ?? ''));
    });
    message = `Version ${version.number} is in use again ${version.tenantId ? `for ${customer} only` : 'for every customer'}.`;
  } catch (error) {
    if (!(error instanceof PromptRefused)) throw error;
    done(prompt, { problem: error.message });
  }
  done(prompt, { changed: message });
}

/**
 * Stops using a saved version. For every customer: back to the original
 * wording. For this customer: back to whatever every customer uses.
 */
export async function clearPrompt(formData: FormData) {
  const { tenantId, customer } = await requireStaff();
  const prompt = readPrompt(formData);
  const own = formData.get('scope') === 'own';
  await withPlatformScope((tx) => clearActivePrompt(tx, prompt, own ? tenantId : null));
  done(prompt, {
    changed: own
      ? `${customer} now uses the all-customers ${PROMPTS[prompt].title.toLowerCase()}.`
      : `Every customer without its own version now uses the original ${PROMPTS[prompt].title.toLowerCase()}.`,
  });
}

/** Deletes a saved version that is not in use. */
export async function deletePrompt(formData: FormData) {
  const { tenantId } = await requireStaff();
  const prompt = readPrompt(formData);
  let message: string;
  try {
    const version = await withPlatformScope(async (tx) => {
      const found = await tx.query.promptVersions.findFirst({ where: (v, { eq: is }) => is(v.id, String(formData.get('id') ?? '')) });
      if (found?.tenantId && found.tenantId !== tenantId) throw new PromptRefused('That version belongs to another customer.');
      return deletePromptVersion(tx, String(formData.get('id') ?? ''));
    });
    message = `Version ${version.number} is deleted.`;
  } catch (error) {
    if (!(error instanceof PromptRefused)) throw error;
    done(prompt, { problem: error.message });
  }
  done(prompt, { changed: message });
}

export type TryState = { answer?: string; error?: string; channel?: 'call' | 'chat'; question?: string } | null;

/**
 * What the agent would answer with the draft in place of this prompt, for the
 * customer being viewed. A call is answered by the talking agent, as when an
 * employee rings us; WhatsApp by the guideline answerer, as a typed question
 * is. Nothing is saved, sent or charged to a customer's allowance.
 */
export async function tryPrompt(_previous: TryState, formData: FormData): Promise<TryState> {
  const { tenantId } = await requireStaff();
  const prompt = readPrompt(formData);
  const question = String(formData.get('question') ?? '').trim().slice(0, 500);
  const channel = formData.get('channel') === 'chat' ? 'chat' : 'call';
  const draft = String(formData.get('body') ?? '').replace(/\r\n/g, '\n').trim();
  if (!question) return { error: 'Write a question to try.', channel };
  if (!draft) return { error: 'The prompt is empty.', channel, question };
  if (draft.length > MAX_PROMPT_LENGTH) return { error: 'The prompt is too long.', channel, question };

  try {
    const answer = await withTenant(tenantId, async (tx) => {
      const prompts = { ...(await promptsFor(tx, tenantId)), [prompt]: draft };
      const employeeId = String(formData.get('employeeId') ?? '');
      const employee = employeeId ? ((await tx.query.employees.findFirst({ where: eq(employees.id, employeeId) })) ?? null) : null;
      if (channel === 'chat') {
        const reply = await answerQuestion(tx, tenantId, question, {
          employeeId: employee?.id ?? null,
          employeeName: employee?.fullName ?? null,
          channel: 'chat',
          prompts,
        });
        return reply.text;
      }
      const [tenant, settings] = await Promise.all([
        tx.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }),
        tx.query.tenantSettings.findFirst({ where: eq(tenantSettings.tenantId, tenantId) }),
      ]);
      if (!settings) throw new Error('This customer has no settings row');
      return previewCallReply({ tx, tenantId, settings, companyName: tenant?.name ?? '' }, { employee, said: question, prompts });
    });
    return { answer: answer || '(no reply)', channel, question };
  } catch (error) {
    console.error('[prompts] trying a draft failed:', (error as Error).message);
    const reason = /credit|quota/i.test((error as Error).message) ? 'the model account has no credits or quota left' : (error as Error).message.slice(0, 200);
    return { error: `Could not answer right now: ${reason}.`, channel, question };
  }
}
