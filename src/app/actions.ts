'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { cases, employees, tenantSettings } from '@/db/schema';
import type { InboundMessage } from '@/lib/channels/types';
import { handleInbound } from '@/lib/conversation/engine';
import { selectionId, type OptionNumber } from '@/lib/conversation/flow';
import { sendDueFollowUps } from '@/lib/conversation/followup';
import { closeCasesExplainedByData, findGaps, runDailyCheck } from '@/lib/detection/run';
import { importAttendanceFile } from '@/lib/mapping/import';
import { buildContext } from '@/lib/runtime';
import { canManageSettings, getActiveTenantId, getSession, setActiveTenant, signOut } from '@/lib/auth';
import { env } from '@/lib/env';

async function requireTenant() {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) throw new Error('No customer selected');
  return { session, tenantId };
}

/** Who would be contacted for a date. Sends nothing. */
export async function previewCheck(_prev: unknown, formData: FormData) {
  const { tenantId } = await requireTenant();
  const date = String(formData.get('date') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Choose a date' };

  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    const { gaps, skipped } = await findGaps(tx, tenantId, date, ctx.settings);
    return {
      date,
      skipped,
      gaps: gaps.map((g) => ({
        name: g.fullName,
        code: g.empCode,
        mobile: g.mobileE164,
        meaning: g.meaning,
        raw: g.rawStatus,
        alreadyOpen: Boolean(g.existingCaseId),
      })),
    };
  });
}

/** The daily check, run by hand. */
export async function runCheck(formData: FormData) {
  const { tenantId } = await requireTenant();
  const date = String(formData.get('date') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

  await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    await closeCasesExplainedByData(tx, tenantId, date);
    await runDailyCheck(ctx, { date, trigger: 'manual' });
  });
  revalidatePath('/');
  revalidatePath('/cases');
}

/**
 * Plays the part of the employee or their manager, so the whole flow can be
 * demonstrated and tested without WhatsApp. Only available while the platform is
 * in dry run - with real credentials this would message a real person.
 */
export async function simulateReply(formData: FormData) {
  const { tenantId } = await requireTenant();
  if (!env.DRY_RUN) throw new Error('Simulation is only available in dry run');

  const caseId = String(formData.get('caseId') ?? '');
  const option = Number(formData.get('option') ?? 0);
  const text = String(formData.get('text') ?? '').trim();
  const selection = String(formData.get('selection') ?? '');
  const from = String(formData.get('from') ?? '');

  await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);

    let sender = from;
    if (!sender && caseId) {
      const [row] = await tx
        .select({ mobile: employees.mobileE164 })
        .from(cases)
        .innerJoin(employees, eq(employees.id, cases.employeeId))
        .where(eq(cases.id, caseId));
      sender = row?.mobile ?? '';
    }
    if (!sender) throw new Error('No number to send from');

    const base = {
      providerMessageId: `sim.${randomUUID()}`,
      from: sender,
      receivedAt: new Date(),
      raw: { simulated: true },
    };

    const inbound: InboundMessage =
      selection || (option >= 1 && option <= 4)
        ? {
            ...base,
            kind: 'button',
            selectionId: selection || selectionId(caseId, option as OptionNumber),
            selectionTitle: text || undefined,
            text: text || undefined,
          }
        : { ...base, kind: 'text', text };

    await handleInbound(ctx, inbound);
  });

  revalidatePath('/cases');
  if (caseId) revalidatePath(`/cases/${caseId}`);
  revalidatePath('/');
}

/** Sends any day-2 reminders that are due, rather than waiting for the worker. */
export async function runFollowUps() {
  const { tenantId } = await requireTenant();
  await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    await sendDueFollowUps(ctx);
  });
  revalidatePath('/cases');
}

export async function closeCase(formData: FormData) {
  const { session, tenantId } = await requireTenant();
  const caseId = String(formData.get('caseId') ?? '');
  const reason = String(formData.get('reason') ?? 'Closed by HR');

  await withTenant(tenantId, (tx) =>
    tx
      .update(cases)
      .set({ status: 'resolved', resolvedAt: new Date(), closeReason: `${reason} (${session.name})`, updatedAt: new Date() })
      .where(and(eq(cases.tenantId, tenantId), eq(cases.id, caseId))),
  );
  revalidatePath(`/cases/${caseId}`);
  revalidatePath('/cases');
}

export async function flagForHr(formData: FormData) {
  const { tenantId } = await requireTenant();
  const caseId = String(formData.get('caseId') ?? '');
  await withTenant(tenantId, (tx) =>
    tx
      .update(cases)
      .set({ status: 'needs_hr', needsHrReason: 'Flagged by HR', updatedAt: new Date() })
      .where(and(eq(cases.tenantId, tenantId), eq(cases.id, caseId))),
  );
  revalidatePath(`/cases/${caseId}`);
}

export async function updateSettings(formData: FormData) {
  const { session, tenantId } = await requireTenant();
  if (!canManageSettings(session)) throw new Error('Not allowed');

  const bool = (name: string) => formData.get(name) === 'on';
  const int = (name: string, fallback: number) => {
    const value = Number(formData.get(name));
    return Number.isFinite(value) ? value : fallback;
  };

  await withTenant(tenantId, (tx) =>
    tx
      .update(tenantSettings)
      .set({
        checkTime: String(formData.get('checkTime') ?? '10:30'),
        schedulerEnabled: bool('schedulerEnabled'),
        sendingEnabled: bool('sendingEnabled'),
        actionsEnabled: bool('actionsEnabled'),
        sendBacklogSummary: bool('sendBacklogSummary'),
        maxOutstandingQuestions: int('maxOutstandingQuestions', 0),
        followUpAfterDays: int('followUpAfterDays', 2),
        callAfterDays: int('callAfterDays', 3),
        approvalTimeoutHours: int('approvalTimeoutHours', 24),
        quietHoursStart: String(formData.get('quietHoursStart') ?? '20:00'),
        quietHoursEnd: String(formData.get('quietHoursEnd') ?? '09:00'),
        updatedAt: new Date(),
      })
      .where(eq(tenantSettings.tenantId, tenantId)),
  );
  revalidatePath('/settings');
  revalidatePath('/');
}

export async function importAttendance(formData: FormData) {
  const { session, tenantId } = await requireTenant();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return;

  const buffer = Buffer.from(await file.arrayBuffer());
  await withTenant(tenantId, async (tx) => {
    await importAttendanceFile(tx, tenantId, buffer, {
      source: 'upload',
      filename: file.name,
      createdBy: session.userId,
    });
    await closeCasesExplainedByData(tx, tenantId);
  });
  revalidatePath('/mapping');
  revalidatePath('/');
}

export async function switchTenant(formData: FormData) {
  const session = await getSession();
  if (!session || session.tenantId) return;
  await setActiveTenant(String(formData.get('tenantId') ?? ''));
  revalidatePath('/', 'layout');
}

export async function signOutAction() {
  await signOut();
  redirect('/login');
}
