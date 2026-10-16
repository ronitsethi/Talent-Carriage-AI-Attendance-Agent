import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { cases } from '@/db/schema';
import { handleInbound, type EngineHooks } from '@/lib/conversation/engine';
import { selectionId } from '@/lib/conversation/flow';
import { sendFollowUpMessage } from '@/lib/conversation/followup';
import { sheetSelectionId } from '@/lib/conversation/sheet';
import type { ChatVerdict } from '@/lib/conversation/talk';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, tapOption, typeText, type Scenario } from './helpers/scenario';

/**
 * The flow sheet on WhatsApp: taps walk down its menus, typing goes to the
 * conversation, and both end on the same outcomes a talking call records.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

const DATES = ['2026-08-17', '2026-08-18'];

async function twoAbsences() {
  scenario = await makeScenario();
  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, DATES.map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A|A' })));
    for (const date of DATES) await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
  });
  scenario.channel.clear();
}

/** A conversation that always comes to this verdict, and records what it was asked. */
function conversing(verdict: Partial<ChatVerdict>, seen: { menu: string | null; text: string }[] = []): EngineHooks {
  return {
    converse: async (_ctx, turn) => {
      seen.push({ menu: turn.menu, text: turn.text });
      return { reply: 'Okay.', outcome: null, leaveChoice: null, note: null, action: 'continue', handoverReason: null, ...verdict };
    },
  };
}

const sent = () => scenario.channel.history().map((s) => s.message as { kind: string; body: string; buttons?: { id: string; title: string }[]; rows?: { id: string; title: string }[] });

async function inbound(message: Parameters<typeof handleInbound>[1], hooks?: EngineHooks) {
  return withTenant(scenario.tenantId, async (tx) => handleInbound({ ...scenario.context(tx), hooks }, message));
}

async function caseOn(date: string) {
  return withTenant(scenario.tenantId, (tx) => tx.query.cases.findFirst({ where: eq(cases.attDate, date) }));
}

describe('the flow sheet on WhatsApp', () => {
  it('asks what happened after "Yes, I was absent", then leave or Loss of Pay', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');

    await inbound(tapOption(scenario.mobile, selectionId(first!.id, 1)));
    const reasons = sent()[0]!;
    expect(reasons.kind).toBe('list');
    expect(reasons.rows!.map((r) => r.title)).toEqual([
      'Unwell', 'Family emergency', 'Personal work', 'Other reason', 'Resigned / left job', 'It was my weekly off', 'Comp off',
    ]);
    expect((await caseOn('2026-08-17'))!.status, 'not settled by the first tap').toBe('asked');

    await inbound(tapOption(scenario.mobile, sheetSelectionId(first!.id, 'unwell')));
    expect(sent()[1]!.buttons!.map((b) => b.title)).toEqual(['Apply leave', 'Loss of Pay']);

    scenario.channel.clear();
    await inbound(tapOption(scenario.mobile, sheetSelectionId(first!.id, 'leave')));
    expect(sent()[0]!.body).toMatch(/^Please apply Sick Leave, or any leave you have available, for 17-Aug-2026 in the HRMS by \d{2}-\w{3}-\d{4}\.$/);
    expect(sent()[1]!.body, 'then the next date').toContain('18-Aug-2026');

    const settled = await caseOn('2026-08-17');
    expect(settled!.status).toBe('answered');
    expect(settled!.replyOption).toBe(1);
    expect((settled!.context as { outcome?: { code: string } }).outcome?.code).toBe('absent_unwell');
  });

  it('closes a Loss of Pay day', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    for (const step of [selectionId(first!.id, 1), sheetSelectionId(first!.id, 'personal'), sheetSelectionId(first!.id, 'lop')]) {
      await inbound(tapOption(scenario.mobile, step));
    }
    const settled = await caseOn('2026-08-17');
    expect(settled!.status).toBe('resolved');
    expect(sent().some((m) => m.body === 'Noted. 17-Aug-2026 will be treated as Loss of Pay as per policy.')).toBe(true);
  });

  it('takes a typed "other reason", then asks leave or Loss of Pay', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await inbound(tapOption(scenario.mobile, selectionId(first!.id, 1)));
    await inbound(tapOption(scenario.mobile, sheetSelectionId(first!.id, 'other')));
    await inbound(typeText(scenario.mobile, 'Had to go to my village for a wedding'));
    await inbound(tapOption(scenario.mobile, sheetSelectionId(first!.id, 'leave')));

    const settled = await caseOn('2026-08-17');
    expect((settled!.context as { outcome?: { code: string; note: string } }).outcome).toMatchObject({
      code: 'absent_other',
      note: 'Had to go to my village for a wedding',
    });
  });

  it('settles in one message when they say it all in words', async () => {
    await twoAbsences();
    const seen: { menu: string | null; text: string }[] = [];
    await inbound(
      typeText(scenario.mobile, 'I was at a client site in Gurgaon that day'),
      conversing({ outcome: 'on_duty_client_visit', note: 'client site in Gurgaon', reply: 'Got it - please apply On-Duty for 17-Aug-2026.' }, seen),
    );

    expect(seen[0]!.text).toBe('I was at a client site in Gurgaon that day');
    // Typed with no menu open: about the date asked most recently.
    const settled = await caseOn('2026-08-18');
    expect(settled!.status).toBe('answered');
    expect(settled!.replyOption).toBe(2);
    expect(sent()[0]!.body, 'the conversation wrote the reply').toBe('Got it - please apply On-Duty for 17-Aug-2026.');
  });

  it('puts the leave buttons under a typed absence, and remembers the reason', async () => {
    await twoAbsences();
    await inbound(typeText(scenario.mobile, 'main bimaar tha'), conversing({ outcome: 'absent_unwell', reply: 'Get well soon! Leave or Loss of Pay?' }));
    expect(sent()[0]!.kind).toBe('buttons');
    expect(sent()[0]!.body).toBe('Get well soon! Leave or Loss of Pay?');

    // "leave le lunga", typed: the conversation gives only the choice, and the reason comes from the menu.
    const seen: { menu: string | null; text: string }[] = [];
    await inbound(typeText(scenario.mobile, 'leave le lunga'), conversing({ leaveChoice: 'leave', reply: 'Theek hai.' }, seen));
    expect(seen[0]!.menu).toContain('Absent - unwell');
    expect((await caseOn('2026-08-18'))!.status).toBe('answered');
  });

  it('tells the conversation where they are in the menus', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await inbound(tapOption(scenario.mobile, selectionId(first!.id, 2)));
    const seen: { menu: string | null; text: string }[] = [];
    await inbound(typeText(scenario.mobile, 'what does regularisation mean?'), conversing({ reply: 'It means…' }, seen));
    expect(seen[0]!.menu).toContain('No, I was working');
  });

  it('hands over when the conversation says so', async () => {
    await twoAbsences();
    const outcome = await inbound(typeText(scenario.mobile, 'please call me, this is confusing'), conversing({ action: 'handover', handoverReason: 'Wants a call', reply: 'Sure, HR will call you.' }));
    expect(outcome).toMatchObject({ action: 'handed_to_hr' });
    expect((await caseOn('2026-08-18'))!.status).toBe('needs_hr');
  });

  it('reminds them of exactly what they were told', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    for (const step of [selectionId(first!.id, 2), sheetSelectionId(first!.id, 'late_early'), sheetSelectionId(first!.id, 'late')]) {
      await inbound(tapOption(scenario.mobile, step));
    }
    scenario.channel.clear();
    await withTenant(scenario.tenantId, async (tx) => {
      const row = await tx.query.cases.findFirst({ where: eq(cases.id, first!.id) });
      const employee = await tx.query.employees.findFirst();
      await sendFollowUpMessage(scenario.context(tx), row!, employee!);
    });
    expect(sent()[0]!.body).toBe('Reminder about 17-Aug-2026: "Please raise a late-coming regularisation for 17-Aug-2026 in the HRMS." Have you done it?');
  });
});
