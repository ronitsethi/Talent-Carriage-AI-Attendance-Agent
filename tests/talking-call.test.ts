import { afterEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { calls, cases, employees } from '@/db/schema';
import { runDailyCheck } from '@/lib/detection/run';
import { handleTurn, openingTurn, placeCaseCall } from '@/lib/voice/session';
import { datePrompt, followUpPrompt } from '@/lib/conversation/voice-script';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * The talking call.
 *
 * It asks the same questions as the keypad call, records the same answers, and
 * sweeps the backlog the same way - the employee simply answers in their own
 * words instead of pressing a key. These tests exist to keep those two things
 * true together: if the spoken path ever recorded a date differently from the
 * keypad path, nobody would know which to believe.
 */

const heard = (turn: { intro?: string; speak: string }) => [turn.intro, turn.speak].filter(Boolean).join(' ');
let scenario: Scenario;

afterEach(async () => {
  await scenario?.cleanup();
});

async function absentWeekOnTheAgent(settings = {}, employeeOverrides = {}) {
  scenario = await makeScenario(
    { defaultChannel: 'voice', callMode: 'agent', callerId: '+912269871077', ...settings },
    { preferredChannel: 'voice', ...employeeOverrides },
  );
  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(
      tx,
      scenario.tenantId,
      scenario.employeeId,
      ['2026-09-21', '2026-09-22', '2026-09-23'].map((date) => ({
        date,
        meaning: 'absent_full' as const,
        raw: 'A',
      })),
    );
    for (const date of ['2026-09-21', '2026-09-22', '2026-09-23']) {
      await runDailyCheck(scenario.context(tx), { date, trigger: 'manual' });
    }
  });
}

describe('choosing between a keypad call and a talking one', () => {
  it('uses the conversation line for an employee set to it', async () => {
    await absentWeekOnTheAgent();

    expect(scenario.voiceAgent.history(), 'three dates, three talking calls').toHaveLength(3);
    expect(scenario.voice.history(), 'nothing should go out on the keypad line').toHaveLength(0);

    await withTenant(scenario.tenantId, async (tx) => {
      const rows = await tx.select().from(calls);
      expect(rows.every((r) => r.provider === 'livekit')).toBe(true);
    });
  });

  it('uses the keypad line when the employee overrides the customer default', async () => {
    await absentWeekOnTheAgent({}, { callMode: 'keypad' });

    expect(scenario.voice.history()).toHaveLength(3);
    expect(scenario.voiceAgent.history()).toHaveLength(0);
  });

  it('falls back to the keypad when no conversation line is configured', async () => {
    scenario = await makeScenario(
      { defaultChannel: 'voice', callMode: 'agent' },
      { preferredChannel: 'voice' },
    );
    await withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
        { date: '2026-09-21', meaning: 'absent_full', raw: 'A' },
      ]);
      // A customer without LiveKit has no agent provider at all.
      const ctx = { ...scenario.context(tx), voiceAgent: null };
      await runDailyCheck(ctx, { date: '2026-09-21', trigger: 'manual' });
    });

    expect(scenario.voice.history(), 'a working call beats a silent one').toHaveLength(1);
  });
});

describe('how a talking call words its questions', () => {
  it('asks the question instead of reading out a keypad menu', async () => {
    await absentWeekOnTheAgent();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const newest = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-23') });
      const call = await tx.query.calls.findFirst({ where: eq(calls.caseId, newest!.id) });

      const opening = await openingTurn(ctx, call!.id);
      const said = heard(opening);
      expect(said).not.toContain('Press 1');
      expect(said).not.toContain('press');
      expect(said).toContain('23 September');
      expect(said).toContain('were you absent that day');
    });
  });

  it('still spells out the keys on a keypad call', () => {
    expect(datePrompt('21 September', 'keypad')).toContain('Press 1 if you were absent');
    expect(datePrompt('21 September', 'spoken')).not.toContain('Press');
    expect(followUpPrompt(1, '21 September', 'keypad')).toContain('Press 1 if it is done');
    expect(followUpPrompt(1, '21 September', 'spoken')).not.toContain('Press');
  });
});

describe('answering out loud', () => {
  it('records the same answers a keypad call would, and sweeps the backlog', async () => {
    await absentWeekOnTheAgent();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const newest = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-23') });
      const call = await tx.query.calls.findFirst({ where: eq(calls.caseId, newest!.id) });

      const opening = await openingTurn(ctx, call!.id);
      // Said, not pressed - and in the Hinglish people actually speak.
      let turn = await handleTurn(ctx, call!.id, opening.nextCaseId!, { speech: 'haan main bimaar tha' });
      const answered: string[] = ['2026-09-23'];
      while (!turn.done && turn.nextCaseId) {
        const current = await tx.query.cases.findFirst({ where: eq(cases.id, turn.nextCaseId) });
        answered.push(current!.attDate);
        turn = await handleTurn(ctx, call!.id, turn.nextCaseId, { speech: 'no I was working that day' });
      }

      expect(answered, 'the date it rang about, then oldest first').toEqual([
        '2026-09-23',
        '2026-09-21',
        '2026-09-22',
      ]);
      expect(heard(turn)).toContain('All 3 days are now confirmed');

      const rows = await tx.select().from(cases).orderBy(asc(cases.attDate));
      expect(rows.every((r) => r.status === 'answered')).toBe(true);
      expect(rows.map((r) => r.replyOption)).toEqual([2, 2, 1]);
    });
  });

  it('keeps a transcript, so a spoken call reads like a chat in the portal', async () => {
    await absentWeekOnTheAgent();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const newest = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-23') });
      const call = await tx.query.calls.findFirst({ where: eq(calls.caseId, newest!.id) });

      const opening = await openingTurn(ctx, call!.id);
      await handleTurn(ctx, call!.id, opening.nextCaseId!, { speech: 'I was unwell' });

      const row = await tx.query.calls.findFirst({ where: eq(calls.id, call!.id) });
      const transcript = row!.transcript ?? [];
      expect(transcript.map((t) => t.role)).toEqual(['agent', 'employee', 'agent']);
      expect(transcript[1]!.text, 'what they said, not a key').toBe('I was unwell');
    });
  });

  it('hands over to HR when it cannot understand, rather than guessing', async () => {
    await absentWeekOnTheAgent();

    await withTenant(scenario.tenantId, async (tx) => {
      const ctx = scenario.context(tx);
      const newest = await tx.query.cases.findFirst({ where: eq(cases.attDate, '2026-09-23') });
      const call = await tx.query.calls.findFirst({ where: eq(calls.caseId, newest!.id) });
      const opening = await openingTurn(ctx, call!.id);

      const first = await handleTurn(ctx, call!.id, opening.nextCaseId!, { speech: 'mmm' });
      expect(first.retry).toBe(true);
      expect(heard(first)).toContain('did not quite catch that');
      expect(heard(first), 'the re-ask must not mention keys either').not.toContain('Press');

      const second = await handleTurn(ctx, call!.id, opening.nextCaseId!, { speech: 'mmm' });
      expect(second.done).toBe(true);
      expect(second.speak).toContain('HR team');
    });
  });
});
