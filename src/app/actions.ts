'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant } from '@/db';
import {
  actions,
  approvals,
  calls,
  cases,
  codeMappings,
  conversations,
  employees,
  mappingProfiles,
  messages,
  tenantSettings,
  unmappedCodes,
} from '@/db/schema';
import type { InboundMessage } from '@/lib/channels/types';
import { handleInbound } from '@/lib/conversation/engine';
import { selectionId, type OptionNumber } from '@/lib/conversation/flow';
import { sendDueFollowUps } from '@/lib/conversation/followup';
import { closeCasesExplainedByData, findGaps, runDailyCheck } from '@/lib/detection/run';
import { importAttendanceFile } from '@/lib/mapping/import';
import { analyseFile, buildFieldMap, type Analysis } from '@/lib/mapping/analyse';
import { PLATFORM_FIELDS, REQUIRED_FIELDS, type PlatformField } from '@/lib/mapping/apply';
import type { Meaning } from '@/lib/mapping/meanings';
import { buildContext } from '@/lib/runtime';
import { channelFor, contactCase, contactCaseById, type ContactResult } from '@/lib/contact';
import { ensureCase } from '@/lib/detection/run';
import { handleTurn, openingTurn, placeCaseCall } from '@/lib/voice/session';
import { canManageSettings, getActiveTenantId, getSession, setActiveTenant, signOut } from '@/lib/auth';
import { env } from '@/lib/env';
import { DEFAULT_AGENT_VOICE, isAgentVoice } from '@/lib/voice/voices';
import { datesInRange } from '@/lib/dates';

async function requireTenant() {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) throw new Error('No customer selected');
  return { session, tenantId };
}

function readRange(formData: FormData): string[] {
  const from = String(formData.get('from') ?? formData.get('date') ?? '');
  const to = String(formData.get('to') ?? '') || from;
  return datesInRange(from, to);
}

/** Who would be contacted over a range. Sends nothing. */
export async function previewCheck(formData: FormData) {
  const { tenantId } = await requireTenant();
  const dates = readRange(formData);
  if (!dates.length) return { error: 'Choose a valid date range' };

  return withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    const rows = [];
    for (const date of dates) {
      const { gaps } = await findGaps(tx, tenantId, date, ctx.settings);
      for (const gap of gaps) {
        rows.push({
          date,
          name: gap.fullName,
          code: gap.empCode,
          mobile: gap.mobileE164,
          meaning: gap.meaning,
          raw: gap.rawStatus,
          channel: gap.preferredChannel,
          alreadyOpen: Boolean(gap.existingCaseId),
        });
      }
    }
    return { dates, rows };
  });
}

/**
 * The daily check, run by hand over one date or a range.
 *
 * Running a range is exactly the same as running each day in turn: one case per
 * employee per date, and a date that already has a case is left alone. So a
 * range can be re-run safely, and only genuinely new dates are messaged about.
 */
export async function runCheck(formData: FormData) {
  const { tenantId } = await requireTenant();
  const dates = readRange(formData);
  if (!dates.length) return;

  await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    for (const date of dates) {
      await closeCasesExplainedByData(tx, tenantId, date);
      await runDailyCheck(ctx, { date, trigger: 'manual' });
    }
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
        operatingMode: formData.get('operatingMode') === 'automatic' ? 'automatic' : 'manual',
        sendingEnabled: bool('sendingEnabled'),
        actionsEnabled: bool('actionsEnabled'),
        sendBacklogSummary: bool('sendBacklogSummary'),
        maxOutstandingQuestions: int('maxOutstandingQuestions', 0),
        followUpAfterDays: int('followUpAfterDays', 2),
        callAfterDays: int('callAfterDays', 3),
        approvalTimeoutHours: int('approvalTimeoutHours', 24),
        quietHoursStart: String(formData.get('quietHoursStart') ?? '20:00'),
        quietHoursEnd: String(formData.get('quietHoursEnd') ?? '09:00'),
        // An unknown voice would leave calls silent, so anything unrecognised
        // falls back rather than being stored.
        agentVoice: isAgentVoice(String(formData.get('agentVoice') ?? '')) 
          ? String(formData.get('agentVoice'))
          : DEFAULT_AGENT_VOICE,
        agentVoicePace: String(
          Math.min(1.3, Math.max(0.7, Number(formData.get('agentVoicePace') ?? 0.95) || 0.95)),
        ),
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

/**
 * Undoes a case entirely, so the date looks untouched again.
 *
 * The case is deleted rather than rewound. A case rewound to `queued` is not
 * the same thing as a date nobody has contacted: it still shows an Open link,
 * still carries a case id, and - worst of all - the dashboard starts it
 * unticked, so the next "Contact selected" would quietly skip the very date
 * that had just been reset. Deleting it puts the row back among its
 * neighbours, and the case is created again the moment anyone is contacted.
 *
 * Used to re-run a demo, or to start again after a wrong number or a mistaken
 * reply. `resetAllCases` has always worked this way; this now matches it.
 */
export async function resetCase(formData: FormData) {
  const { tenantId } = await requireTenant();
  const caseId = String(formData.get('caseId') ?? '');

  await withTenant(tenantId, async (tx) => {
    const target = await tx.query.cases.findFirst({
      where: and(eq(cases.tenantId, tenantId), eq(cases.id, caseId)),
    });
    if (!target) return;

    await tx.delete(messages).where(eq(messages.caseId, caseId));
    await tx.delete(actions).where(eq(actions.caseId, caseId));
    await tx.delete(calls).where(eq(calls.caseId, caseId));

    // The employee may now be mid-conversation about a case that no longer
    // exists, so clear the pointer rather than leaving it dangling.
    await tx
      .update(conversations)
      .set({ activeCaseId: null })
      .where(and(eq(conversations.employeeId, target.employeeId), eq(conversations.activeCaseId, caseId)));

    await tx.delete(cases).where(eq(cases.id, caseId));
  });

  revalidatePath('/cases');
  revalidatePath('/');
  // The case page no longer has a case to show, so go back to the list.
  redirect('/cases');
}

/**
 * Clears every case, conversation and action for this customer, leaving the
 * employees and attendance in place. The way to run the demo again from a clean
 * start without re-importing anything.
 */
export async function resetAllCases() {
  const { session, tenantId } = await requireTenant();
  if (!canManageSettings(session)) throw new Error('Not allowed');

  await withTenant(tenantId, async (tx) => {
    // Order matters: approvals and messages point at actions and cases.
    await tx.delete(approvals).where(eq(approvals.tenantId, tenantId));
    await tx.delete(actions).where(eq(actions.tenantId, tenantId));
    await tx.delete(messages).where(eq(messages.tenantId, tenantId));
    await tx.delete(conversations).where(eq(conversations.tenantId, tenantId));
    // Calls cascade from their case, but a call need not have one - so it is
    // named here rather than left to the foreign key.
    await tx.delete(calls).where(eq(calls.tenantId, tenantId));
    await tx.delete(cases).where(eq(cases.tenantId, tenantId));
  });

  revalidatePath('/');
  revalidatePath('/cases');
}

/**
 * The dashboard puts the switches and the bulk-contact button in one form,
 * because nested forms are not valid HTML. The switches therefore carry their
 * arguments through `.bind()` rather than through a button's name and value -
 * React reserves that name for its own action id, and using it silently breaks
 * the button.
 */
export async function setChannelFromRow(employeeId: string, channel: string) {
  if (!employeeId) return;
  const { tenantId } = await requireTenant();
  await withTenant(tenantId, (tx) =>
    tx
      .update(employees)
      .set({ preferredChannel: channel === 'voice' ? 'voice' : 'whatsapp', updatedAt: new Date() })
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))),
  );
  revalidatePath('/');
  revalidatePath('/cases');
}

/**
 * Keypad call or spoken conversation, for one employee.
 *
 * Only meaningful for someone already set to Call. Clearing it back to the
 * customer's default is deliberate: most customers want one kind of call, and
 * the per-person switch is the exception rather than the rule.
 */
export async function setCallModeFromRow(employeeId: string, mode: string) {
  if (!employeeId) return;
  const { tenantId } = await requireTenant();
  await withTenant(tenantId, (tx) =>
    tx
      .update(employees)
      .set({ callMode: mode === 'agent' ? 'agent' : 'keypad', updatedAt: new Date() })
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))),
  );
  revalidatePath('/');
  revalidatePath('/cases');
}

export async function setModeFromRow(employeeId: string, mode: string) {
  if (!employeeId) return;
  const { tenantId } = await requireTenant();
  await withTenant(tenantId, (tx) =>
    tx
      .update(employees)
      .set({ operatingMode: mode === 'automatic' ? 'automatic' : 'manual', updatedAt: new Date() })
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))),
  );
  revalidatePath('/');
  revalidatePath('/cases');
}

/**
 * Contacts everyone ticked on the dashboard, each on their own channel.
 *
 * A row may not have a case yet - it is simply an absent day - so the case is
 * created first. The unique key on (employee, date) means a double click or two
 * people pressing at once still produces one case and one contact.
 */
export async function contactSelected(formData: FormData) {
  const targets = formData.getAll('target').map(String).filter(Boolean);
  if (!targets.length) return;
  const { tenantId } = await requireTenant();

  const outcomes: ContactResult[] = [];

  await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);

    // Group by person: ticking five dates for someone on Call must ring them
    // once, not five times. The call sweeps the backlog by itself.
    const byEmployee = new Map<string, string[]>();
    for (const target of targets) {
      const [employeeId, date] = target.split('|');
      if (!employeeId || !date) continue;
      byEmployee.set(employeeId, [...(byEmployee.get(employeeId) ?? []), date]);
    }

    for (const [employeeId, dates] of byEmployee) {
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, employeeId) });
      if (!employee) continue;

      // Every ticked date becomes a case, whether or not it is asked right now.
      const created = [];
      for (const date of dates.sort()) {
        const caseRow = await ensureCase(tx, tenantId, employeeId, date);
        if (caseRow) created.push(caseRow);
      }
      if (!created.length) continue;

      if (channelFor(employee, ctx.settings.defaultChannel) === 'voice') {
        // One call, about the most recent date; the older ones follow inside it.
        outcomes.push(await contactCase(ctx, created[created.length - 1]!, employee));
      } else {
        // WhatsApp stacks in a chat, so each date gets its own message.
        for (const caseRow of created) outcomes.push(await contactCase(ctx, caseRow, employee));
      }
    }
  });

  revalidatePath('/');
  revalidatePath('/cases');
  redirect(`/?${noticeFor(outcomes)}`);
}

/**
 * Turns what happened into something the dashboard can say out loud.
 *
 * Pressing Contact and having nothing happen, with no explanation, is the worst
 * thing this page can do - and it is exactly what it did when a customer's
 * master sending switch was off. Whatever the reason, it gets said.
 */
function noticeFor(outcomes: ContactResult[]): string {
  const sent = outcomes.filter((o) => o.contacted).length;
  const blocked = outcomes.filter((o) => !o.contacted) as Extract<ContactResult, { contacted: false }>[];
  const params = new URLSearchParams();

  if (sent) params.set('sent', String(sent));
  if (blocked.length) {
    // The same reason usually applies to everyone, so say it once.
    params.set('blocked', [...new Set(blocked.map((o) => o.reason))].join('; '));
  }
  if (!outcomes.length) params.set('blocked', 'Nothing was selected');
  return params.toString();
}

/** The per-employee WhatsApp / Call switch shown on every flagged employee. */
export async function setEmployeeChannel(formData: FormData) {
  const { tenantId } = await requireTenant();
  const employeeId = String(formData.get('employeeId') ?? '');
  const channel = formData.get('channel') === 'voice' ? 'voice' : 'whatsapp';

  await withTenant(tenantId, (tx) =>
    tx
      .update(employees)
      .set({ preferredChannel: channel, updatedAt: new Date() })
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))),
  );
  revalidatePath('/cases');
  revalidatePath('/');
}

/** The per-employee Auto / Manual switch. */
export async function setEmployeeMode(formData: FormData) {
  const { tenantId } = await requireTenant();
  const employeeId = String(formData.get('employeeId') ?? '');
  const mode = formData.get('mode') === 'automatic' ? 'automatic' : 'manual';

  await withTenant(tenantId, (tx) =>
    tx
      .update(employees)
      .set({ operatingMode: mode, updatedAt: new Date() })
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId))),
  );
  revalidatePath('/cases');
  revalidatePath('/');
}

/**
 * Contacts one employee about one date now, on whichever channel they are set
 * to. This is the button HR uses in manual mode.
 */
export async function contactNow(formData: FormData) {
  const { tenantId } = await requireTenant();
  const caseId = String(formData.get('caseId') ?? '');

  const result = await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    return contactCaseById(ctx, caseId);
  });
  revalidatePath(`/cases/${caseId}`);
  revalidatePath('/cases');
  revalidatePath('/');

  // Say why nothing happened. Silence here reads as a broken button.
  if (result && !result.contacted) redirect(`/cases/${caseId}?blocked=${encodeURIComponent(result.reason)}`);
}

/**
 * Plays out a call turn without a phone, so the flow can be demonstrated in dry
 * run exactly as the WhatsApp simulator does.
 */
export async function simulateCallAnswer(formData: FormData) {
  const { tenantId } = await requireTenant();
  if (!env.DRY_RUN) throw new Error('Call simulation is only available in dry run');

  const caseId = String(formData.get('caseId') ?? '');
  const digits = String(formData.get('digits') ?? '');
  const speech = String(formData.get('speech') ?? '').trim();

  await withTenant(tenantId, async (tx) => {
    const ctx = await buildContext(tx, tenantId);
    const caseRow = await tx.query.cases.findFirst({ where: eq(cases.id, caseId) });
    if (!caseRow) return;

    // Use the live call for this case, or start one so there is something to answer.
    let call = await tx.query.calls.findFirst({
      where: and(eq(calls.caseId, caseId), inArray(calls.status, ['queued', 'ringing', 'in_progress', 'simulated'])),
      orderBy: desc(calls.id),
    });
    if (!call) {
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, caseRow.employeeId) });
      if (!employee) return;
      const placed = await placeCaseCall(ctx, caseRow, employee);
      if (!placed.placed) return;
      call = await tx.query.calls.findFirst({ where: eq(calls.id, placed.callId) });
    }
    if (!call) return;

    if (call.status !== 'in_progress') await openingTurn(ctx, call.id);
    await handleTurn(ctx, call.id, caseId, { digits: digits || undefined, speech: speech || undefined });
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath('/cases');
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

/* ------------------------------------------------------------------ *
 * Mapping: teaching the platform how to read one customer's file
 * ------------------------------------------------------------------ */

/**
 * Reads an uploaded file and proposes a mapping for somebody to correct.
 *
 * Nothing is imported and nothing is activated. The result is a draft: our
 * best guess at which column is which and what each code means, saved so the
 * screen can be reopened without the file.
 */
export async function analyseMappingFile(formData: FormData) {
  const { session, tenantId } = await requireTenant();
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect('/mapping?problem=' + encodeURIComponent('Choose a file first'));
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let analysis: Analysis;
  try {
    analysis = analyseFile(buffer);
  } catch (error) {
    redirect('/mapping?problem=' + encodeURIComponent((error as Error).message));
  }

  await withTenant(tenantId, async (tx) => {
    // One draft at a time: a second upload replaces the first rather than
    // leaving two half-finished mappings to choose between.
    await tx
      .delete(mappingProfiles)
      .where(and(eq(mappingProfiles.tenantId, tenantId), eq(mappingProfiles.status, 'draft')));

    await tx.insert(mappingProfiles).values({
      tenantId,
      name: `From ${file.name}`,
      status: 'draft',
      hrmsHint: null,
      fieldMap: buildFieldMap({
        sheetName: analysis.sheetName,
        fields: analysis.fields,
        layout: analysis.layout,
        year: analysis.year,
        separator: analysis.separator,
      }),
      detected: analysis as unknown as Record<string, unknown>,
      sourceFile: buffer.toString('base64'),
      sourceFilename: file.name,
      notes: `${analysis.rowCount} rows, ${analysis.columns.length} columns`,
      createdBy: session.userId,
    });
  });

  revalidatePath('/mapping');
  redirect('/mapping');
}

/**
 * Saves the corrected mapping and makes it the one imports use.
 *
 * The previous active profile is archived rather than deleted, so an import made
 * last month can still be explained by the mapping that was in force then.
 */
export async function saveMapping(formData: FormData) {
  const { tenantId } = await requireTenant();
  const draftId = String(formData.get('profileId') ?? '');

  const missing = REQUIRED_FIELDS.filter((field) => !String(formData.get(`field:${field}`) ?? '').trim());
  if (missing.length) {
    redirect(
      '/mapping?problem=' +
        encodeURIComponent(`These are needed before a file can be read: ${missing.join(', ')}`),
    );
  }

  let imported = '';
  let unresolved = 0;

  await withTenant(tenantId, async (tx) => {
    const draft = await tx.query.mappingProfiles.findFirst({
      where: and(eq(mappingProfiles.tenantId, tenantId), eq(mappingProfiles.id, draftId)),
    });
    if (!draft) return;

    const analysis = draft.detected as unknown as Analysis | null;
    const fields: Partial<Record<PlatformField, string[]>> = {};
    for (const field of PLATFORM_FIELDS) {
      const chosen = formData.getAll(`field:${field}`).map(String).filter(Boolean);
      if (chosen.length) fields[field] = chosen;
    }

    const layout = String(formData.get('layout') ?? 'row_per_day') as 'column_per_day' | 'row_per_day';
    const fieldMap = buildFieldMap({
      sheetName: String(formData.get('sheetName') ?? analysis?.sheetName ?? ''),
      fields,
      layout,
      dateColumn: String(formData.get('dateColumn') ?? ''),
      year: Number(formData.get('year')) || null,
      separator: String(formData.get('separator') ?? '') || null,
    });

    const [saved] = await tx
      .insert(mappingProfiles)
      .values({
        tenantId,
        name: String(formData.get('name') ?? draft.name),
        status: 'active',
        hrmsHint: String(formData.get('hrmsHint') ?? '') || null,
        fieldMap,
        detected: draft.detected,
        notes: draft.notes,
        activatedAt: new Date(),
      })
      .returning();

    // Every code the file contained gets a meaning, including the ones left as
    // "unknown" - recorded deliberately, so nobody is messaged about them.
    const codes = (analysis?.codes ?? []).map((c) => c.code);
    const rows = codes
      .map((code) => ({
        tenantId,
        profileId: saved!.id,
        code: code.toUpperCase(),
        meaning: String(formData.get(`code:${code}`) ?? 'unknown') as Meaning,
        chase: formData.get(`chase:${code}`) === 'on' ? true : null,
        confirmedAt: new Date(),
      }))
      .filter((row) => row.code);
    if (rows.length) await tx.insert(codeMappings).values(rows);

    await tx
      .update(mappingProfiles)
      .set({ status: 'archived', supersededBy: saved!.id })
      .where(
        and(
          eq(mappingProfiles.tenantId, tenantId),
          eq(mappingProfiles.status, 'active'),
          sql`${mappingProfiles.id} <> ${saved!.id}`,
        ),
      );

    await tx.delete(mappingProfiles).where(eq(mappingProfiles.id, draftId));

    // The file that was just mapped is the file to read. Asking for it a second
    // time is how the mapping and the data drift apart.
    if (draft.sourceFile) {
      const result = await importAttendanceFile(tx, tenantId, Buffer.from(draft.sourceFile, 'base64'), {
        source: 'upload',
        filename: draft.sourceFilename ?? 'mapped file',
      });
      await closeCasesExplainedByData(tx, tenantId);
      imported = `${result.report.daysImported} days for ${result.report.employeesSeen} employees`;
      unresolved = Object.keys(result.report.unmappedCodes).length;
    }
  });

  revalidatePath('/mapping');
  revalidatePath('/');
  const params = new URLSearchParams({ saved: '1' });
  if (imported) params.set('imported', imported);
  if (unresolved) params.set('unresolved', String(unresolved));
  redirect(`/mapping?${params.toString()}`);
}

/** Gives one code a meaning, from the unmapped-codes list after an import. */
export async function setCodeMeaning(formData: FormData) {
  const { tenantId } = await requireTenant();
  const code = String(formData.get('code') ?? '').toUpperCase();
  const meaning = String(formData.get('meaning') ?? '') as Meaning;
  if (!code || !meaning) return;

  await withTenant(tenantId, async (tx) => {
    const profile = await tx.query.mappingProfiles.findFirst({
      where: and(eq(mappingProfiles.tenantId, tenantId), eq(mappingProfiles.status, 'active')),
    });
    if (!profile) return;

    await tx
      .insert(codeMappings)
      .values({ tenantId, profileId: profile.id, code, meaning, confirmedAt: new Date() })
      .onConflictDoUpdate({
        target: [codeMappings.tenantId, codeMappings.profileId, codeMappings.code],
        set: { meaning, confirmedAt: new Date() },
      });

    await tx
      .update(unmappedCodes)
      .set({ resolvedAt: new Date() })
      .where(and(eq(unmappedCodes.tenantId, tenantId), eq(unmappedCodes.code, code)));
  });

  revalidatePath('/mapping');
}
