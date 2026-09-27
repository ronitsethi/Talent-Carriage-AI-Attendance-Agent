import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { closeDb, withTenant } from '@/db';
import { cases, messages } from '@/db/schema';
import { handleInbound, pendingCases } from '@/lib/conversation/engine';
import { selectionId } from '@/lib/conversation/flow';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, tapOption, typeText, type Scenario } from './helpers/scenario';

/**
 * The agreed behaviour for repeated absence:
 *
 *  - one question per absent date, sent as it is found
 *  - an unanswered date is NEVER chased again on its own
 *  - questions therefore pile up while the employee ignores them
 *  - answering one moves that date through the flow, and immediately produces a
 *    summary of what is left plus the question for the next date
 *  - this repeats until every date is cleared
 */

const DATES = ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'];
let scenario: Scenario;

afterEach(async () => {
  await scenario?.cleanup();
});

async function setupFourAbsences(settings = {}) {
  scenario = await makeScenario(settings);
  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(
      tx,
      scenario.tenantId,
      scenario.employeeId,
      DATES.map((date) => ({ date, meaning: 'absent_full' as const, raw: 'A|A' })),
    );
    for (const date of DATES) {
      // Manual is the default mode, so these runs are the HR-triggered kind.
      await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
    }
  });
}

describe('one question per absent date, and no reminders', () => {
  it('asks once per date and lets them pile up', async () => {
    await setupFourAbsences();

    const sent = scenario.channel.history();
    expect(sent).toHaveLength(4);
    expect(sent.every((s) => s.message.kind === 'template')).toBe(true);

    await withTenant(scenario.tenantId, async (tx) => {
      const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
      expect(rows.map((r) => r.attDate)).toEqual(DATES);
      expect(rows.every((r) => r.status === 'asked')).toBe(true);
    });
  });

  it('never re-asks a date the employee has ignored', async () => {
    await setupFourAbsences();
    await withTenant(scenario.tenantId, async (tx) => {
      // Re-running the check, as the scheduler would each day, must add nothing.
      for (const date of DATES) {
        const result = await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
        expect(result.casesCreated).toBe(0);
        expect(result.messagesSent).toBe(0);
      }
    });
    expect(scenario.channel.history()).toHaveLength(4);
  });

  it('carries the date in every question, so four look-alike messages stay distinct', async () => {
    await setupFourAbsences();
    const previews = scenario.channel.history().map((s) => (s.message as { preview: string }).preview);
    expect(previews.some((p) => p.includes('17-Aug-2026'))).toBe(true);
    expect(previews.some((p) => p.includes('20-Aug-2026'))).toBe(true);
  });
});

describe('answering one date moves the chain along', () => {
  it('sends guidance, then a summary and the next date, in the same conversation', async () => {
    await setupFourAbsences();
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [second] = await tx.select().from(cases).where(eq(cases.attDate, '2026-08-18'));
      const outcome = await handleInbound(
        scenario.context(tx),
        tapOption(scenario.mobile, selectionId(second!.id, 2)),
      );
      expect(outcome).toMatchObject({ handled: true, action: 'answered', caseId: second!.id });
    });

    const sent = scenario.channel.history();
    expect(sent).toHaveLength(2);

    // 1. the guidance for the date they answered
    expect(sent[0]!.message).toMatchObject({ kind: 'text' });
    expect((sent[0]!.message as { body: string }).body).toContain('regularization for 18-Aug-2026');

    // 2. the backlog summary plus the next date's options, as a list
    const next = sent[1]!.message as { kind: string; body: string; rows: { id: string }[] };
    expect(next.kind).toBe('list');
    expect(next.body).toContain('3 days');
    expect(next.body).toContain('17-Aug-2026'); // oldest outstanding comes next
    expect(next.rows).toHaveLength(4);
  });

  it('asks the oldest remaining date next, not the newest', async () => {
    await setupFourAbsences();
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [last] = await tx.select().from(cases).where(eq(cases.attDate, '2026-08-20'));
      await handleInbound(scenario.context(tx), tapOption(scenario.mobile, selectionId(last!.id, 1)));
    });

    const list = scenario.channel.history().find((s) => s.message.kind === 'list')!;
    const rowCaseId = (list.message as { rows: { id: string }[] }).rows[0]!.id.split(':')[1];
    await withTenant(scenario.tenantId, async (tx) => {
      const asked = await tx.query.cases.findFirst({ where: eq(cases.id, rowCaseId!) });
      expect(asked!.attDate).toBe('2026-08-17');
    });
  });

  it('works through the whole backlog, one answer at a time', async () => {
    await setupFourAbsences();

    for (let i = 0; i < DATES.length; i++) {
      await withTenant(scenario.tenantId, async (tx) => {
        const [next] = await tx
          .select()
          .from(cases)
          .where(eq(cases.status, 'asked'))
          .orderBy(asc(cases.attDate))
          .limit(1);
        expect(next, `expected an outstanding date on round ${i + 1}`).toBeDefined();
        await handleInbound(scenario.context(tx), tapOption(scenario.mobile, selectionId(next!.id, 1)));
      });
    }

    await withTenant(scenario.tenantId, async (tx) => {
      const rows = await tx.select().from(cases);
      expect(rows.every((r) => r.status === 'answered')).toBe(true);
      expect(await pendingCases(scenario.context(tx), scenario.employeeId)).toHaveLength(0);
    });

    const bodies = scenario.channel.history().map((s) => JSON.stringify(s.message));
    expect(bodies.some((b) => b.includes('All 4 pending attendance dates are now confirmed'))).toBe(true);
  });

  it('starts the escalation clocks only for the date that was answered', async () => {
    await setupFourAbsences();

    await withTenant(scenario.tenantId, async (tx) => {
      const [first] = await tx.select().from(cases).where(eq(cases.attDate, '2026-08-17'));
      await handleInbound(scenario.context(tx), tapOption(scenario.mobile, selectionId(first!.id, 3)));

      const answered = await tx.query.cases.findFirst({ where: eq(cases.id, first!.id) });
      expect(answered!.followUpDueAt).not.toBeNull();
      expect(answered!.callDueAt).not.toBeNull();

      const untouched = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-08-19') });
      expect(untouched!.followUpDueAt).toBeNull();
      expect(untouched!.status).toBe('asked');
    });
  });
});

describe('the outstanding-question cap', () => {
  it('holds extra dates back and releases one as each is answered', async () => {
    await setupFourAbsences({ maxOutstandingQuestions: 2 });

    // Only two questions go out; the rest wait in `queued`.
    expect(scenario.channel.history()).toHaveLength(2);
    await withTenant(scenario.tenantId, async (tx) => {
      const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
      expect(rows.map((r) => r.status)).toEqual(['asked', 'asked', 'queued', 'queued']);
    });

    scenario.channel.clear();
    await withTenant(scenario.tenantId, async (tx) => {
      const [first] = await tx.select().from(cases).where(eq(cases.attDate, '2026-08-17'));
      await handleInbound(scenario.context(tx), tapOption(scenario.mobile, selectionId(first!.id, 1)));

      const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
      // The chain asks one date at a time: the next-oldest is re-offered inside
      // the conversation, and the held-back dates stay queued until their turn.
      // Releasing them early would push out questions the employee never asked
      // for, which is the noise the cap exists to prevent.
      expect(rows.map((r) => r.status)).toEqual(['answered', 'asked', 'queued', 'queued']);
    });

    // The summary still names the full backlog, so nothing is hidden from them.
    const list = scenario.channel.history().find((s) => s.message.kind === 'list')!;
    const body = (list.message as { body: string }).body;
    expect(body).toContain('3 days');
    expect(body).toContain('18-Aug-2026');
  });

  it('asks a queued date once it becomes the next in line', async () => {
    await setupFourAbsences({ maxOutstandingQuestions: 2 });

    // Answer the two that were asked; the third should then be offered.
    await withTenant(scenario.tenantId, async (tx) => {
      for (const date of ['2026-08-17', '2026-08-18']) {
        const [row] = await tx.select().from(cases).where(eq(cases.attDate, date));
        await handleInbound(scenario.context(tx), tapOption(scenario.mobile, selectionId(row!.id, 1)));
      }
      const third = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-08-19') });
      expect(third!.status).toBe('asked');
    });
  });
});

describe('typed replies and duplicates', () => {
  it('understands a bare "2" without calling a model', async () => {
    await setupFourAbsences();
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const outcome = await handleInbound(scenario.context(tx), typeText(scenario.mobile, '2'));
      expect(outcome).toMatchObject({ handled: true, action: 'answered' });
      if (outcome.handled) expect(outcome.classification.source).toBe('rules');
    });

    const guidance = scenario.channel.history()[0]!.message as { body: string };
    expect(guidance.body).toContain('regularization');
  });

  it('ignores the same message delivered twice', async () => {
    await setupFourAbsences();
    scenario.channel.clear();

    await withTenant(scenario.tenantId, async (tx) => {
      const [first] = await tx.select().from(cases).where(eq(cases.attDate, '2026-08-17'));
      const tap = tapOption(scenario.mobile, selectionId(first!.id, 1));
      const once = await handleInbound(scenario.context(tx), tap);
      const twice = await handleInbound(scenario.context(tx), tap);
      expect(once.handled).toBe(true);
      expect(twice).toEqual({ handled: false, reason: 'duplicate' });

      const inbound = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.direction, 'inbound'), eq(messages.caseId, first!.id)));
      expect(inbound).toHaveLength(1);
    });
  });

  it('does nothing for a number we do not know', async () => {
    await setupFourAbsences();
    await withTenant(scenario.tenantId, async (tx) => {
      const outcome = await handleInbound(scenario.context(tx), typeText('910000000000', 'hello'));
      expect(outcome).toEqual({ handled: false, reason: 'unknown_sender' });
    });
  });
});

describe('guards before anything is sent', () => {
  it('creates the case but sends nothing while sending is switched off', async () => {
    scenario = await makeScenario({ sendingEnabled: false });
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' },
      ]);
      const result = await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
      expect(result.casesCreated).toBe(1);
      expect(result.messagesSent).toBe(0);
      expect(result.blocked[0]?.reason).toMatch(/switched off/i);
    });
    expect(scenario.channel.history()).toHaveLength(0);
  });

  it('never messages someone who has opted out', async () => {
    scenario = await makeScenario({}, { whatsappOptOut: true });
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' },
      ]);
      const result = await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
      expect(result.messagesSent).toBe(0);
      expect(result.blocked[0]?.reason).toMatch(/opted out/i);
    });
  });

  it('ignores weekly offs, holidays and anything unmapped', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-08-15', meaning: 'holiday', raw: 'HO|HO', working: false },
        { date: '2026-08-16', meaning: 'weekly_off', raw: 'WO|WO', working: false },
        { date: '2026-08-21', meaning: 'unknown', raw: 'ZZ' },
        { date: '2026-08-22', meaning: 'leave_approved', raw: 'CL' },
      ]);
      for (const date of ['2026-08-15', '2026-08-16', '2026-08-21', '2026-08-22']) {
        const result = await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
        expect(result.casesCreated, `${date} should not create a case`).toBe(0);
      }
    });
    expect(scenario.channel.history()).toHaveLength(0);
  });
});

afterEach(async () => {
  // Pool is shared across tests; close once at the end of the file.
});

process.on('beforeExit', () => {
  void closeDb();
});
