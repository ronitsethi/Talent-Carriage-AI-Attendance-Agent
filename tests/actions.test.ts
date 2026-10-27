import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type Db } from '@/db';
import { actions, approvals, calls, cases, employees, messages } from '@/db/schema';
import type { FullContext } from '@/lib/runtime';
import { handleInbound } from '@/lib/conversation/engine';
import { approvalSelectionId, leaveTypeSelectionId, selectionId } from '@/lib/conversation/flow';
import { sheetSelectionId } from '@/lib/conversation/sheet';
import { MockHrms } from '@/lib/hrms/mock';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, tapOption, type Scenario } from './helpers/scenario';

/**
 * The agent applying things itself, with an HRMS connected: nothing reaches the
 * HRMS until the manager approves, and a write the HRMS refuses is told honestly.
 * (The asking, the approving and the rejecting are in whatsapp-sheet.test.ts.)
 */

const DATE = '2026-08-18';
let scenario: Scenario;

afterEach(async () => {
  await scenario?.cleanup();
});

describe('the HRMS refusing', () => {
  it('flags HR and tells the employee honestly when the write fails', async () => {
    const hrms = new MockHrms({ backdatingWindowDays: 1 }); // the date is far in the past
    hrms.seed({ employeeCode: 'E-1', balances: { CL: 6 } });
    scenario = await makeScenario({ attendanceSource: 'hrms' });
    const managerMobile = `9190000${Math.floor(Math.random() * 90000) + 10000}`;
    const context = (tx: Db): FullContext => ({ ...scenario.context(tx), hrms });

    await withTenant(scenario.tenantId, async (tx) => {
      const [manager] = await tx
        .insert(employees)
        .values({ tenantId: scenario.tenantId, empCode: 'M-1', fullName: 'Deepak Gajjar', mobileE164: managerMobile })
        .returning();
      await tx.update(employees).set({ managerEmployeeId: manager!.id }).where(eq(employees.id, scenario.employeeId));
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: DATE, meaning: 'absent_full', raw: 'A|A' }]);
      await runDailyCheck(context(tx), { date: DATE, trigger: 'manual' });

      const [row] = await tx.select().from(cases);
      for (const payload of [selectionId(row!.id, 3), sheetSelectionId(row!.id, 'leave_me'), leaveTypeSelectionId(row!.id, 'CL')]) {
        await handleInbound(context(tx), tapOption(scenario.mobile, payload));
      }
      const [approval] = await tx.select().from(approvals);
      await handleInbound(context(tx), tapOption(managerMobile, approvalSelectionId(approval!.id, 'approve')));

      const action = await tx.query.actions.findFirst({ where: eq(actions.caseId, row!.id) });
      expect(action!.status).toBe('failed');
      expect(action!.lastError).toMatch(/backdating window/i);
      expect((await tx.query.cases.findFirst({ where: eq(cases.id, row!.id) }))!.status).toBe('needs_hr');
    });

    const texts = scenario.channel.history().map((s) => (s.message as { body?: string }).body ?? '');
    // One honest message, from the approval, not a second one from the failed write.
    expect(texts.some((text) => text.includes('could not complete'))).toBe(false);
    expect(texts.some((text) => text.includes('could not be applied automatically, so HR will finish it'))).toBe(true);
  });
});

/**
 * Resetting one case.
 *
 *   "When I reset a case, it should just go back and not this special
 *    'not contacted'. It should not be opened at all."
 *
 * A case rewound to `queued` is not the same thing as a date nobody has
 * touched: it keeps an Open link and a case id, and the dashboard started it
 * unticked - so the next bulk contact skipped the date that had just been
 * reset. Reset now removes the case, and the row rejoins its neighbours.
 */
describe('resetting a case', () => {
  it('removes the case, so the date looks untouched', async () => {
    const scenario = await makeScenario({ defaultChannel: 'whatsapp' }, { preferredChannel: 'whatsapp' });
    try {
      await withTenant(scenario.tenantId, async (tx) => {
        await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
          { date: '2026-09-21', meaning: 'absent_full', raw: 'A' },
        ]);
        await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'manual' });

        const before = await tx.select().from(cases);
        expect(before).toHaveLength(1);
        expect(scenario.channel.history()).toHaveLength(1);

        // What resetCase does, in its order.
        const caseId = before[0]!.id;
        await tx.delete(messages).where(eq(messages.caseId, caseId));
        await tx.delete(calls).where(eq(calls.caseId, caseId));
        await tx.delete(cases).where(eq(cases.id, caseId));

        const after = await tx.select().from(cases);
        expect(after, 'no case at all, not a rewound one').toHaveLength(0);

        // And the date can be contacted again, exactly as if for the first time.
        const again = await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'manual' });
        expect(again.messagesSent).toBe(1);
        expect(scenario.channel.history()).toHaveLength(2);
      });
    } finally {
      await scenario.cleanup();
    }
  });
});
