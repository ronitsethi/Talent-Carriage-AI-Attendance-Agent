import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant, type Db } from '@/db';
import { actions, approvals, cases, employees } from '@/db/schema';
import {
  handleApprovalDecision,
  handleOfferResponse,
  offerAction,
  type ActionContext,
} from '@/lib/actions/engine';
import { handleInbound } from '@/lib/conversation/engine';
import { approvalSelectionId, offerSelectionId, selectionId } from '@/lib/conversation/flow';
import { MockHrms } from '@/lib/hrms/mock';
import type { HrmsCapability } from '@/lib/hrms/types';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, tapOption, type Scenario } from './helpers/scenario';

/**
 * The action path: the employee asks, the manager approves, and only then does
 * anything reach the HRMS - with a reference number as proof.
 */

const DATE = '2026-08-18';
let scenario: Scenario;
let managerId: string;
let managerMobile: string;

afterEach(async () => {
  await scenario?.cleanup();
});

async function setup(opts: { capabilities?: HrmsCapability[]; balances?: Record<string, number>; withManager?: boolean } = {}) {
  const hrms = new MockHrms({ capabilities: opts.capabilities });
  scenario = await makeScenario({
    actionsEnabled: true,
    allowedActions: ['apply_leave', 'apply_regularisation'],
  });

  managerMobile = `9190000${Math.floor(Math.random() * 90000) + 10000}`;
  if (opts.withManager !== false) {
    managerId = await withPlatformScope(async (tx) => {
      const [manager] = await tx
        .insert(employees)
        .values({
          tenantId: scenario.tenantId,
          empCode: 'M-1',
          fullName: 'Deepak Gajjar',
          mobileE164: managerMobile,
        })
        .returning();
      await tx
        .update(employees)
        .set({ managerEmployeeId: manager!.id })
        .where(eq(employees.id, scenario.employeeId));
      return manager!.id;
    });
  }

  hrms.seed({ employeeCode: 'E-1', balances: opts.balances ?? { CL: 6, SL: 4, LWP: 999 } });
  hrms.seed({ employeeCode: 'M-1' });

  const context = (tx: Db): ActionContext => ({
    ...scenario.context(tx),
    hrms,
    hooks: {
      onAnswered: (ctx, caseRow, employee, option) =>
        offerAction({ ...(ctx as ActionContext), hrms }, caseRow, employee, option),
      onOfferResponse: async (ctx, caseRow, employee, choice) => {
        await handleOfferResponse({ ...(ctx as ActionContext), hrms }, caseRow, employee, choice);
      },
      onApprovalDecision: async (ctx, approvalId, choice, approver) => {
        await handleApprovalDecision({ ...(ctx as ActionContext), hrms }, approvalId, choice, approver);
      },
    },
  });

  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
      { date: DATE, meaning: 'absent_full', raw: 'A|A' },
    ]);
    await runDailyCheck(context(tx), { date: DATE, trigger: 'manual' });
  });

  return { hrms, context };
}

const bodies = () =>
  scenario.channel.history().map((s) => {
    const m = s.message as { body?: string; preview?: string; to: string };
    return { to: m.to, text: m.body ?? m.preview ?? '' };
  });

describe('offering to do the work', () => {
  it('offers leave after "I was absent", naming the balance', async () => {
    const { context } = await setup();
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
    });

    const sent = bodies();
    expect(sent[0]!.text).toContain('Please apply leave'); // the guidance from the flowchart
    expect(sent[1]!.text).toContain('6 day(s) of Casual leave');
    expect(sent[1]!.text).toContain('Shall I apply');
  });

  it('does not offer when the HRMS cannot write', async () => {
    const { context } = await setup({ capabilities: ['fetch_leave_balance', 'read_request_status'] });
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
    });

    // Guidance only, and the backlog chain carries on as usual.
    expect(bodies().every((b) => !b.text.includes('Shall I apply'))).toBe(true);
  });

  it('says so plainly when there is no balance, instead of offering', async () => {
    const { context } = await setup({ balances: { CL: 0, SL: 0 } });
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
    });

    expect(bodies().some((b) => b.text.includes('no leave balance available'))).toBe(true);
  });

  it('leaves the employee to do it themselves if they decline', async () => {
    const { context, hrms } = await setup();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'self')));

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, row!.id) });
      expect(after!.status).toBe('answered');
    });

    expect(hrms.snapshot().requests).toHaveLength(0);
    expect(bodies().some((b) => b.text.includes('please apply it yourself'))).toBe(true);
  });
});

describe('manager approval', () => {
  it('asks the manager, and writes to the HRMS only once they approve', async () => {
    const { context, hrms } = await setup();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'accept')));
    });

    // Nothing in the HRMS yet: the manager has not decided.
    expect(hrms.snapshot().requests).toHaveLength(0);
    const toManager = bodies().filter((b) => b.to === managerMobile);
    expect(toManager[0]!.text).toContain('Ankit Panwar has requested leave for 18-Aug-2026');

    await withTenant(scenario.tenantId, async (tx) => {
      const [approval] = await tx.select().from(approvals);
      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));

      const action = await tx.query.actions.findFirst({ where: eq(actions.caseId, (await tx.select().from(cases))[0]!.id) });
      expect(action!.status).toBe('executed');
      expect(action!.hrmsReference).toMatch(/^LV-2026-/);

      const [row] = await tx.select().from(cases);
      expect(row!.status).toBe('resolved');
      expect(row!.closeReason).toContain('approved in the HRMS');
    });

    const request = hrms.snapshot().requests[0]!;
    expect(request).toMatchObject({ kind: 'leave', employeeCode: 'E-1', status: 'approved', leaveType: 'CL' });
    // Approving consumed balance, as a real HRMS would.
    expect(hrms.snapshot().employees[0]!.balances.CL).toBe(5);

    const toEmployee = bodies().filter((b) => b.to === scenario.mobile);
    expect(toEmployee.at(-1)!.text).toMatch(/has been approved.*LV-2026-/s);
  });

  it('tells the employee and flags HR when the manager rejects', async () => {
    const { context, hrms } = await setup();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'accept')));
      const [approval] = await tx.select().from(approvals);
      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'reject')));

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, row!.id) });
      expect(after!.status).toBe('needs_hr');
      expect(after!.needsHrReason).toMatch(/rejected/i);
    });

    expect(hrms.snapshot().requests).toHaveLength(0);
    expect(bodies().some((b) => b.text.includes('was not approved'))).toBe(true);
  });

  it('ignores a second tap on the same approval', async () => {
    const { context, hrms } = await setup();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'accept')));
      const [approval] = await tx.select().from(approvals);

      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));
      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));
    });

    // One leave request, not two - the second decision is refused outright.
    expect(hrms.snapshot().requests).toHaveLength(1);
  });

  it('hands the case to HR when nobody can approve it', async () => {
    const { context, hrms } = await setup({ withManager: false });

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'accept')));

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, row!.id) });
      expect(after!.status).toBe('needs_hr');
      expect(after!.needsHrReason).toMatch(/no manager/i);
    });
    expect(hrms.snapshot().requests).toHaveLength(0);
  });
});

describe('regularisation', () => {
  it('applies regularisation after "I was working"', async () => {
    const { context, hrms } = await setup();

    await withTenant(scenario.tenantId, async (tx) => {
      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 2)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'accept')));
      const [approval] = await tx.select().from(approvals);
      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));
    });

    const request = hrms.snapshot().requests[0]!;
    expect(request).toMatchObject({ kind: 'regularisation', fromDate: DATE, status: 'approved' });
    expect(request.reference).toMatch(/^RG-2026-/);
  });
});

describe('the HRMS refusing', () => {
  it('flags HR and tells the employee honestly when the write fails', async () => {
    const hrms = new MockHrms({ backdatingWindowDays: 1 }); // the date is far in the past
    scenario = await makeScenario({ actionsEnabled: true, allowedActions: ['apply_leave'] });
    hrms.seed({ employeeCode: 'E-1' });

    managerMobile = `9190000${Math.floor(Math.random() * 90000) + 10000}`;
    await withPlatformScope(async (tx) => {
      const [manager] = await tx
        .insert(employees)
        .values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile })
        .returning();
      await tx.update(employees).set({ managerEmployeeId: manager!.id }).where(eq(employees.id, scenario.employeeId));
    });

    const context = (tx: Db): ActionContext => ({
      ...scenario.context(tx),
      hrms,
      hooks: {
        onAnswered: (ctx, caseRow, employee, option) =>
          offerAction({ ...(ctx as ActionContext), hrms }, caseRow, employee, option),
        onOfferResponse: async (ctx, caseRow, employee, choice) => {
          await handleOfferResponse({ ...(ctx as ActionContext), hrms }, caseRow, employee, choice);
        },
        onApprovalDecision: async (ctx, approvalId, choice, approver) => {
          await handleApprovalDecision({ ...(ctx as ActionContext), hrms }, approvalId, choice, approver);
        },
      },
    });

    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: DATE, meaning: 'absent_full', raw: 'A|A' },
      ]);
      await runDailyCheck(context(tx), { date: DATE, trigger: 'manual' });

      const [row] = await tx.select().from(cases);
      await handleInbound(context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      await handleInbound(context(tx), tapOption(scenario.mobile, offerSelectionId(row!.id, 'accept')));
      const [approval] = await tx.select().from(approvals);
      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));

      const action = await tx.query.actions.findFirst({ where: eq(actions.caseId, row!.id) });
      expect(action!.status).toBe('failed');
      expect(action!.lastError).toMatch(/backdating window/i);

      const after = await tx.query.cases.findFirst({ where: eq(cases.id, row!.id) });
      expect(after!.status).toBe('needs_hr');
    });

    expect(bodies().some((b) => b.text.includes('could not complete'))).toBe(true);
  });
});
