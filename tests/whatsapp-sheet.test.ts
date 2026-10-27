import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { actions, approvals, cases, employees, managers } from '@/db/schema';
import { handleInbound, type EngineHooks } from '@/lib/conversation/engine';
import { approvalSelectionId, leaveTypeSelectionId, selectionId } from '@/lib/conversation/flow';
import { sheetSelectionId } from '@/lib/conversation/sheet';
import type { ChatVerdict } from '@/lib/conversation/talk';
import { runDailyCheck } from '@/lib/detection/run';
import { sendApprovalRequest } from '@/lib/approvals';
import { MockHrms } from '@/lib/hrms/mock';
import type { TenantSettings } from '@/lib/conversation/engine';
import { giveAttendance, makeScenario, tapOption, typeText, type Scenario } from './helpers/scenario';

/**
 * The flow sheet on WhatsApp: taps walk down its menus, typing goes to the
 * conversation, and both end on the same outcomes a talking call records.
 * Anything applied for - leave, regularisation, On-Duty, comp-off - then asks
 * where it stands, and goes to the employee's manager for approval.
 */

let scenario: Scenario;
let hrms: MockHrms | null = null;
let managerMobile: string;
afterEach(async () => {
  await scenario?.cleanup();
  hrms = null;
});

const DATES = ['2026-08-17', '2026-08-18'];

/**
 * Two absent dates for one employee, whose manager Deepak is named in the file
 * by `via`: his mobile in the manager mobile column, or his employee code.
 */
async function twoAbsences(opts: { via?: 'mobile' | 'code' | 'none'; settings?: Partial<TenantSettings>; managerMode?: 'manual' } = {}) {
  scenario = await makeScenario(opts.settings ?? {});
  managerMobile = `9180000${Math.floor(Math.random() * 90000) + 10000}`;
  await withTenant(scenario.tenantId, async (tx) => {
    if (opts.via !== 'none') {
      const [deepak] = await tx
        .insert(employees)
        .values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile })
        .returning();
      await tx
        .update(employees)
        .set(opts.via === 'code' ? { managerEmployeeId: deepak!.id } : { managerMobileE164: managerMobile })
        .where(eq(employees.id, scenario.employeeId));
    }
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, DATES.map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A|A' })));
    for (const date of DATES) await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
    if (opts.managerMode) {
      await tx.insert(managers).values({ tenantId: scenario.tenantId, mobileE164: managerMobile, fullName: 'Deepak Gajjar', operatingMode: 'manual' });
    }
  });
  scenario.channel.clear();
}

/** A conversation that always comes to this verdict, and records what it was asked. */
function conversing(verdict: Partial<ChatVerdict>, seen: { menu: string | null; text: string }[] = []): EngineHooks {
  return {
    converse: async (_ctx, turn) => {
      seen.push({ menu: turn.menu, text: turn.text });
      return { reply: 'Okay.', outcome: null, leaveChoice: null, application: null, note: null, action: 'continue', handoverReason: null, ...verdict };
    },
  };
}

type Sent = { kind: string; to: string; body: string; templateName?: string; variables?: string[]; buttonPayloads?: string[]; buttons?: { id: string; title: string }[]; rows?: { id: string; title: string }[] };
const all = () => scenario.channel.history().map((s) => s.message as unknown as Sent);
/** What the employee was sent. */
const sent = () => all().filter((m) => m.to === scenario.mobile);
/** What their manager was sent. */
const toManager = () => all().filter((m) => m.to === managerMobile);

const context = (tx: Db, hooks?: EngineHooks) => ({ ...scenario.context(tx), hooks, ...(hrms ? { hrms } : {}) });

async function inbound(message: Parameters<typeof handleInbound>[1], hooks?: EngineHooks) {
  return withTenant(scenario.tenantId, async (tx) => handleInbound(context(tx, hooks), message));
}

async function tap(...payloads: string[]) {
  for (const payload of payloads) await inbound(tapOption(scenario.mobile, payload));
}

async function caseOn(date: string) {
  return withTenant(scenario.tenantId, (tx) => tx.query.cases.findFirst({ where: eq(cases.attDate, date) }));
}

async function pendingApproval() {
  return withTenant(scenario.tenantId, (tx) => tx.query.approvals.findFirst({ where: eq(approvals.decision, 'pending') }));
}

describe('the first question', () => {
  it('asks what happened after "I didn\'t come" - weekly off and comp off are their own option now', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 1));
    expect(sent()[0]!.rows!.map((r) => r.title)).toEqual(['Unwell', 'Family emergency', 'Personal work', 'Other reason', 'Resigned / left job']);
    expect((await caseOn('2026-08-17'))!.status, 'not settled by the first tap').toBe('asked');

    scenario.channel.clear();
    await tap(selectionId(first!.id, 4));
    expect(sent()[0]!.body).toBe('Was 17-Aug-2026 your weekly off, or a comp off?');
    expect(sent()[0]!.buttons!.map((b) => b.title)).toEqual(['It was my weekly off', 'Comp off']);
  });

  it('reads a tap on the old template\'s "Already applied leave" as it meant then', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(`case:${first!.id}:3`);
    expect(sent()[0]!.body).toBe('Okay. I have asked Deepak to approve your leave for 17-Aug-2026.');
    expect((await caseOn('2026-08-17'))!.status).toBe('awaiting_approval');
  });
});

describe('asking where it stands, with attendance from a file', () => {
  it('after a reason and "Apply leave": not applied yet is told to apply, and the manager is asked', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 1), sheetSelectionId(first!.id, 'unwell'));
    expect(sent()[1]!.buttons!.map((b) => b.title)).toEqual(['Apply leave', 'Loss of Pay']);

    scenario.channel.clear();
    await tap(sheetSelectionId(first!.id, 'leave'));
    expect(sent()[0]!.body).toBe('Have you applied the leave for 17-Aug-2026 yet?');
    expect(sent()[0]!.buttons!.map((b) => b.title)).toEqual(['Not applied yet', 'Applied, pending']);

    scenario.channel.clear();
    await tap(sheetSelectionId(first!.id, 'app_not'));
    expect(sent()[0]!.body).toMatch(
      /^Please apply Sick Leave, or any leave you have available, for 17-Aug-2026 in the HRMS by \d{2}-\w{3}-\d{4}\. I have also let Deepak know, so they can approve it once you have\.$/,
    );
    expect(sent()[1]!.body, 'then the next date').toContain('18-Aug-2026');

    const [request] = toManager();
    expect(request).toMatchObject({
      kind: 'template',
      templateName: 'manager_approval_request',
      variables: ['Ankit Panwar (E-1)', 'has been asked to apply leave', '17-Aug-2026', 'Absent - unwell'],
    });
    const approval = await pendingApproval();
    expect(request!.buttonPayloads).toEqual([approvalSelectionId(approval!.id, 'approve'), approvalSelectionId(approval!.id, 'reject')]);

    const settled = await caseOn('2026-08-17');
    expect(settled!.status).toBe('awaiting_approval');
    expect((settled!.context as { outcome?: { code: string } }).outcome?.code).toBe('absent_unwell');
  });

  it('closes a Loss of Pay day with nothing for the manager', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 1), sheetSelectionId(first!.id, 'personal'), sheetSelectionId(first!.id, 'lop'));
    expect((await caseOn('2026-08-17'))!.status).toBe('resolved');
    expect(sent().some((m) => m.body === 'Noted. 17-Aug-2026 will be treated as Loss of Pay as per policy.')).toBe(true);
    expect(toManager()).toEqual([]);
  });

  it('"I was on leave": applied and waiting goes straight to the manager', async () => {
    await twoAbsences({ via: 'code' });
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 3));
    expect(sent()[0]!.body).toBe('Okay. Have you applied leave for 17-Aug-2026 yet?');
    expect(sent()[0]!.buttons!.map((b) => b.title)).toEqual(['Not applied yet', 'Applied, pending']);

    scenario.channel.clear();
    await tap(sheetSelectionId(first!.id, 'leave_done'));
    expect(sent()[0]!.body).toBe('Okay. I have asked Deepak to approve your leave for 17-Aug-2026.');
    expect(toManager()[0]!.variables![1]).toBe('has applied leave');
  });

  it('came late: the regularisation goes the same way', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 2), sheetSelectionId(first!.id, 'late_early'), sheetSelectionId(first!.id, 'late'));
    expect(sent().at(-1)!.body).toBe('Have you applied the late-coming regularisation for 17-Aug-2026 yet?');
    scenario.channel.clear();
    await tap(sheetSelectionId(first!.id, 'app_not'));
    expect(sent()[0]!.body).toBe(
      'Please raise a late-coming regularisation for 17-Aug-2026 in the HRMS. I have also let Deepak know, so they can approve it once you have.',
    );
    expect(toManager()[0]!.variables![1]).toBe('has been asked to apply late-coming regularisation');
  });

  it('weekly off goes to HR, and comp off asks where it stands', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    const second = await caseOn('2026-08-18');
    await tap(selectionId(first!.id, 4), sheetSelectionId(first!.id, 'weekly_off'));
    expect((await caseOn('2026-08-17'))!.status).toBe('needs_hr');

    scenario.channel.clear();
    await tap(selectionId(second!.id, 4), sheetSelectionId(second!.id, 'comp_off'));
    expect(sent().at(-1)!.body).toBe('Have you applied the comp-off for 18-Aug-2026 yet?');
  });

  it('understands where it stands when it is typed: "abhi nahi kiya"', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 1), sheetSelectionId(first!.id, 'other'));
    await inbound(typeText(scenario.mobile, 'Had to go to my village for a wedding'));
    await tap(sheetSelectionId(first!.id, 'leave'));
    await inbound(typeText(scenario.mobile, 'abhi nahi kiya'));

    const settled = await caseOn('2026-08-17');
    expect(settled!.status).toBe('awaiting_approval');
    expect((settled!.context as { outcome?: { code: string; note: string } }).outcome).toMatchObject({
      code: 'absent_other',
      note: 'Had to go to my village for a wedding',
    });
    expect(toManager()[0]!.variables![3]).toBe('Had to go to my village for a wedding');
  });
});

describe('typing instead of tapping', () => {
  it('asks where it stands under what the conversation wrote', async () => {
    await twoAbsences();
    const seen: { menu: string | null; text: string }[] = [];
    await inbound(
      typeText(scenario.mobile, 'I was at a client site in Gurgaon that day'),
      conversing({ outcome: 'on_duty_client_visit', note: 'client site in Gurgaon', reply: 'Got it, a client visit.' }, seen),
    );
    expect(seen[0]!.text).toBe('I was at a client site in Gurgaon that day');
    expect(sent()[0]!.body).toBe('Got it, a client visit.\n\nHave you applied the On-Duty (client visit) for 18-Aug-2026 yet?');
  });

  it('takes "already applied" said unasked, without asking it again', async () => {
    await twoAbsences();
    await inbound(
      typeText(scenario.mobile, 'I was on leave, already applied it'),
      conversing({ outcome: 'leave_pending_approval', application: 'applied', reply: 'Okay.' }),
    );
    expect((await caseOn('2026-08-18'))!.status).toBe('awaiting_approval');
    // Not asked again; told plainly that the manager has been asked.
    expect(sent()[0]!.body).toBe('Okay. I have asked Deepak to approve your leave for 18-Aug-2026.');
  });

  it('puts the leave buttons under a typed absence, and remembers the reason', async () => {
    await twoAbsences();
    await inbound(typeText(scenario.mobile, 'main bimaar tha'), conversing({ outcome: 'absent_unwell', reply: 'Get well soon! Leave or Loss of Pay?' }));
    expect(sent()[0]!.kind).toBe('buttons');
    expect(sent()[0]!.body).toBe('Get well soon! Leave or Loss of Pay?');

    const seen: { menu: string | null; text: string }[] = [];
    await inbound(typeText(scenario.mobile, 'leave le lunga'), conversing({ leaveChoice: 'leave', reply: 'Theek hai.' }, seen));
    expect(seen[0]!.menu).toContain('Absent - unwell');
    expect(sent().at(-1)!.body).toBe('Theek hai.\n\nHave you applied the leave for 18-Aug-2026 yet?');
  });

  it('tells the conversation where they are in the menus', async () => {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 2));
    const seen: { menu: string | null; text: string }[] = [];
    await inbound(typeText(scenario.mobile, 'what does regularisation mean?'), conversing({ reply: 'It means…' }, seen));
    expect(seen[0]!.menu).toContain('I was working');
  });

  it('hands over when the conversation says so', async () => {
    await twoAbsences();
    const outcome = await inbound(typeText(scenario.mobile, 'please call me, this is confusing'), conversing({ action: 'handover', handoverReason: 'Wants a call', reply: 'Sure, HR will call you.' }));
    expect(outcome).toMatchObject({ action: 'handed_to_hr' });
    expect((await caseOn('2026-08-18'))!.status).toBe('needs_hr');
  });
});

describe('the manager', () => {
  async function requested() {
    await twoAbsences();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 3), sheetSelectionId(first!.id, 'leave_done'));
    scenario.channel.clear();
    return { first: first!, approval: (await pendingApproval())! };
  }

  it('approves: the employee is told and the date is closed', async () => {
    const { approval } = await requested();
    await inbound(tapOption(managerMobile, approvalSelectionId(approval.id, 'approve')));
    expect(sent()[0]!.body).toBe('Deepak has approved your leave for 17-Aug-2026.');
    expect(toManager()[0]!.body).toBe('Noted - approved. Ankit Panwar has been told on WhatsApp.');
    const closed = await caseOn('2026-08-17');
    expect(closed).toMatchObject({ status: 'resolved', closeReason: 'Approved by Deepak Gajjar' });

    // A second tap changes nothing.
    scenario.channel.clear();
    await inbound(tapOption(managerMobile, approvalSelectionId(approval.id, 'reject')));
    expect(sent()).toEqual([]);
    expect(toManager()[0]!.body).toContain('was already approved');
  });

  it('rejects: the employee is told and the date is closed', async () => {
    const { approval } = await requested();
    await inbound(tapOption(managerMobile, approvalSelectionId(approval.id, 'reject')));
    expect(sent()[0]!.body).toBe('Deepak did not approve your leave for 17-Aug-2026. Please speak to Deepak or HR if you need to.');
    expect(await caseOn('2026-08-17')).toMatchObject({ status: 'resolved', closeReason: 'Not approved by Deepak Gajjar' });
  });

  it('can only be decided by the manager it went to', async () => {
    const { approval } = await requested();
    await inbound(tapOption(scenario.mobile, approvalSelectionId(approval.id, 'approve')));
    expect((await pendingApproval())?.id).toBe(approval.id);
  });

  it('can answer by typing, when one request is waiting', async () => {
    const { approval } = await requested();
    await inbound(typeText(managerMobile, 'ok approved'));
    const decided = await withTenant(scenario.tenantId, (tx) => tx.query.approvals.findFirst({ where: eq(approvals.id, approval.id) }));
    expect(decided!.decision).toBe('approved');
  });

  it('goes to HR when the file names no manager', async () => {
    await twoAbsences({ via: 'none' });
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 3), sheetSelectionId(first!.id, 'leave_done'));
    // Then the next date's question follows it.
    expect(sent().at(-2)!.body).toBe('Okay, noted that you have applied the leave for 17-Aug-2026. HR will follow up on the approval.');
    expect(await caseOn('2026-08-17')).toMatchObject({ status: 'needs_hr', needsHrReason: 'No manager in the file to approve it' });
  });

  it('waits for HR to send it when the manager is set to manual', async () => {
    await twoAbsences({ managerMode: 'manual' });
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 3), sheetSelectionId(first!.id, 'leave_done'));
    expect(toManager()).toEqual([]);
    const approval = await pendingApproval();
    expect(approval!.sentAt).toBeNull();

    await withTenant(scenario.tenantId, async (tx) => sendApprovalRequest(context(tx), approval!.id));
    expect(toManager()).toHaveLength(1);
  });
});

describe('with an HRMS connected', () => {
  async function hrmsScenario() {
    hrms = new MockHrms();
    hrms.seed({ employeeCode: 'E-1', balances: { CL: 6, SL: 4, LWP: 999 } });
    hrms.seed({ employeeCode: 'M-1' });
    await twoAbsences({ settings: { attendanceSource: 'hrms' } });
  }

  it('offers to apply it, asks the leave type, and applies it once the manager approves', async () => {
    await hrmsScenario();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 3));
    expect(sent()[0]!.body).toBe('Okay. Shall I apply leave for 17-Aug-2026 for you?');
    expect(sent()[0]!.buttons!.map((b) => b.title)).toEqual(['Apply it for me', "I'll apply it myself", 'Applied, pending']);

    scenario.channel.clear();
    await tap(sheetSelectionId(first!.id, 'leave_me'));
    expect(sent()[0]!.body).toBe('Which leave shall I apply for 17-Aug-2026?');
    expect(sent()[0]!.rows!.map((r) => r.title)).toEqual(['CL', 'SL']);

    scenario.channel.clear();
    await tap(leaveTypeSelectionId(first!.id, 'CL'));
    expect(sent()[0]!.body).toBe('Okay. I have sent your CL for 17-Aug-2026 to Deepak for approval, and will apply it in the HRMS once they approve.');
    expect(toManager()[0]!.variables!.slice(1)).toEqual(['has asked us to apply CL leave', '17-Aug-2026', 'On leave - leave not yet applied']);
    expect(hrms!.snapshot().requests, 'nothing in the HRMS before the manager approves').toEqual([]);

    const approval = await pendingApproval();
    scenario.channel.clear();
    await inbound(tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));
    const [applied] = hrms!.snapshot().requests;
    expect(applied).toMatchObject({ leaveType: 'CL' });
    expect(await caseOn('2026-08-17')).toMatchObject({ status: 'resolved' });
    expect(toManager()[0]!.body).toBe("Approved. Ankit Panwar's CL for 17-Aug-2026 has been applied in the HRMS, and they have been told on WhatsApp.");
    const action = await withTenant(scenario.tenantId, (tx) => tx.query.actions.findFirst({ where: and(eq(actions.caseId, first!.id)) }));
    expect(action!.status).toBe('executed');
  });

  it('a regularisation the employee will do themselves is the file\'s way after all', async () => {
    await hrmsScenario();
    const first = await caseOn('2026-08-17');
    await tap(selectionId(first!.id, 2), sheetSelectionId(first!.id, 'punch'), sheetSelectionId(first!.id, 'punch_in'));
    expect(sent().at(-1)!.buttons!.map((b) => b.title)).toEqual(['Yes, apply it', "I'll do it myself", 'Applied, pending']);
    scenario.channel.clear();
    await tap(sheetSelectionId(first!.id, 'app_self'));
    expect(sent()[0]!.body).toContain('Please raise a regularisation for your missed in-punch on 17-Aug-2026 in the HRMS');
    expect(toManager()[0]!.variables![1]).toBe('has been asked to apply regularisation for the missed in-punch');
  });
});
