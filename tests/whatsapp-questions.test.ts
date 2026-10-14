import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { cases } from '@/db/schema';
import { handleInbound, type EngineHooks } from '@/lib/conversation/engine';
import { runDailyCheck } from '@/lib/detection/run';
import { giveAttendance, makeScenario, typeText, type Scenario } from './helpers/scenario';

// The classifier is a model; here it is told the message was a question.
vi.mock('@/lib/conversation/classify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversation/classify')>()),
  classifyReply: async (text: string) => ({
    intent: 'question',
    option: null,
    confidence: 0.95,
    source: 'model',
    question: text,
  }),
}));

/**
 * Employees ask things on WhatsApp as well as answer: those questions are
 * answered from the company's guidelines, and only what the guidelines do not
 * cover goes to HR.
 */

let scenario: Scenario;
afterEach(async () => {
  await scenario?.cleanup();
});

function answering(text: string, answered = true): EngineHooks {
  return { answerQuestion: async () => ({ text, answered }) };
}

async function withOpenCase() {
  scenario = await makeScenario();
  await withTenant(scenario.tenantId, async (tx) => {
    await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [
      { date: '2026-08-18', meaning: 'absent_full', raw: 'A|A' },
    ]);
    await runDailyCheck(scenario.context(tx), { date: '2026-08-18', trigger: 'manual' });
  });
  scenario.channel.clear();
}

const sentTexts = () =>
  scenario.channel.history().map((s) => (s.message as { body?: string }).body);

describe('questions on WhatsApp', () => {
  it('answers from the guidelines when nothing is open', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      const outcome = await handleInbound(
        { ...scenario.context(tx), hooks: answering('You get 12 casual leaves a year.') },
        typeText(scenario.mobile, 'How many casual leaves do I get?'),
      );
      expect(outcome).toMatchObject({ handled: true, action: 'answered' });
    });
    expect(sentTexts()).toEqual(['You get 12 casual leaves a year.']);
  });

  it('answers a question asked mid-case, and leaves the date open for its answer', async () => {
    await withOpenCase();
    await withTenant(scenario.tenantId, async (tx) => {
      const outcome = await handleInbound(
        { ...scenario.context(tx), hooks: answering('Regularise within 7 days.') },
        typeText(scenario.mobile, 'By when must I regularise?'),
      );
      expect(outcome).toMatchObject({ handled: true, action: 'answered' });
      const [row] = await tx.select().from(cases).where(eq(cases.tenantId, scenario.tenantId));
      expect(row!.status).not.toBe('needs_hr');
    });
    expect(sentTexts()).toEqual(['Regularise within 7 days.']);
  });

  it('hands to HR only what the guidelines do not cover, with one message', async () => {
    await withOpenCase();
    await withTenant(scenario.tenantId, async (tx) => {
      const outcome = await handleInbound(
        { ...scenario.context(tx), hooks: answering('I will ask HR to come back to you on that.', false) },
        typeText(scenario.mobile, 'Can I carry leave into next year?'),
      );
      expect(outcome).toMatchObject({ handled: true, action: 'handed_to_hr' });
      const [row] = await tx.select().from(cases).where(eq(cases.tenantId, scenario.tenantId));
      expect(row!.status).toBe('needs_hr');
      expect(row!.needsHrReason).toContain('carry leave');
    });
    expect(sentTexts()).toEqual(['I will ask HR to come back to you on that.']);
  });

  it('still logs without replying when no answering is configured', async () => {
    scenario = await makeScenario();
    await withTenant(scenario.tenantId, async (tx) => {
      const outcome = await handleInbound(scenario.context(tx), typeText(scenario.mobile, 'Hello?'));
      expect(outcome).toMatchObject({ handled: true, action: 'logged' });
    });
    expect(scenario.channel.history()).toHaveLength(0);
  });
});
