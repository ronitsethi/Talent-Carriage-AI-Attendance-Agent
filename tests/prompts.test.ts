import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { employees, promptVersions } from '@/db/schema';
import {
  activatePromptVersion,
  clearActivePrompt,
  deletePromptVersion,
  forgetPrompts,
  ORIGINAL,
  PromptRefused,
  promptHistory,
  promptsFor,
  resolvePrompts,
  savePromptVersion,
} from '@/lib/prompts';
import { answerSystem, spellForVoice, talkingSystem } from '@/lib/prompts/build';
import { diffLines } from '@/lib/prompts/diff';
import { prepareGrounding, talkTurn, type TalkArgs } from '@/lib/conversation/talk';
import { makeScenario, type Scenario } from './helpers/scenario';

/**
 * The AI prompts page: six prompts staff can edit, saved as versions for every
 * customer or for one, and put together with the parts code keeps fixed.
 */

// Marks the all-customers rows these tests write, so only those are removed.
const BY = 'prompts.test';

const scenarios: Scenario[] = [];
afterEach(async () => {
  await withPlatformScope((tx) => tx.delete(promptVersions).where(and(isNull(promptVersions.tenantId), eq(promptVersions.createdByName, BY))));
  for (const s of scenarios.splice(0)) await s.cleanup();
  forgetPrompts();
});

async function customer() {
  const s = await makeScenario();
  scenarios.push(s);
  return s;
}

const save = (prompt: 'limits' | 'leave' | 'talking_agent', tenantId: string | null, body: string) =>
  withPlatformScope((tx) => savePromptVersion(tx, { prompt, tenantId, body, userName: BY }));

describe('putting the prompt together', () => {
  it('spells HR and HRMS out for the voice and leaves other words alone', () => {
    expect(spellForVoice('Ask HR, or apply in the HRMS. HR\'s answer.')).toBe('Ask H R, or apply in the H R M S. H R\'s answer.');
    expect(spellForVoice('HRA is part of the salary; CHRO and THRESHOLD stay.')).toBe('HRA is part of the salary; CHRO and THRESHOLD stay.');
  });

  it('gives a call and a WhatsApp chat the same editable text with their own fixed lines', () => {
    const call = talkingSystem(ORIGINAL, 'call');
    const chat = talkingSystem(ORIGINAL, 'chat');
    expect(call).toContain('on a phone call with one of its employees');
    expect(call).toContain('Speech-to-text can mishear');
    expect(call).toContain('ask about the next date if one is given');
    expect(call).toContain('Keep in English: leave');
    expect(call).toContain('do something for them in the H R M S');
    expect(call).not.toMatch(/check with HR\b/);

    expect(chat).toContain('in a WhatsApp chat with one of its employees');
    expect(chat).not.toContain('Speech-to-text');
    expect(chat).toContain('the next one is sent to them separately');
    expect(chat).toContain('do something for them in the HRMS');

    // Every editable prompt is in both, and the outcomes list is still filled in.
    for (const text of [call, chat]) {
      for (const heading of ['HOW YOU TALK', 'ATTENDANCE:', 'LEAVE:', 'SALARY:', 'LIMITS', 'OUTCOMES, AND WHAT THE EMPLOYEE IS TOLD', "YOUR ANSWER'S FIELDS"]) {
        expect(text).toContain(heading);
      }
      expect(text).not.toContain('{outcomes}');
    }
  });

  it('gives the guideline answerer the shared rules and its own fields', () => {
    const call = answerSystem(ORIGINAL, 'call');
    const chat = answerSystem(ORIGINAL, 'chat');
    expect(call).toContain('on a phone call, on behalf of their employer');
    expect(chat).toContain('on WhatsApp, on behalf of their employer');
    expect(chat).toContain('Reply in the language they wrote in');
    for (const text of [call, chat]) {
      expect(text).toContain('HOW YOU ANSWER');
      expect(text).toContain('ATTENDANCE:');
      expect(text).toContain('will raise a ticket for it');
      expect(text).toContain('finished:');
      expect(text).toContain('answered:');
    }
  });

  it("uses a customer's own version over the all-customers one, and that over the original", () => {
    const set = resolvePrompts([
      { prompt: 'limits', tenantId: 'a', body: 'own limits' },
      { prompt: 'limits', tenantId: null, body: 'everyone limits' },
      { prompt: 'leave', tenantId: null, body: 'everyone leave' },
      { prompt: 'not_a_prompt', tenantId: null, body: 'ignored' },
    ]);
    expect(set.limits).toBe('own limits');
    expect(set.leave).toBe('everyone leave');
    expect(set.payroll).toBe(ORIGINAL.payroll);
  });

  it('compares two versions line by line', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
});

describe('versions', () => {
  it('applies an all-customers version to everyone, and a customer version to that customer alone', async () => {
    const a = await customer();
    const b = await customer();

    await save('limits', null, 'LIMITS for everyone');
    expect((await withTenant(a.tenantId, (tx) => promptsFor(tx, a.tenantId))).limits).toBe('LIMITS for everyone');
    expect((await withTenant(b.tenantId, (tx) => promptsFor(tx, b.tenantId))).limits).toBe('LIMITS for everyone');

    await save('limits', a.tenantId, 'LIMITS for A only');
    expect((await withTenant(a.tenantId, (tx) => promptsFor(tx, a.tenantId))).limits).toBe('LIMITS for A only');
    expect((await withTenant(b.tenantId, (tx) => promptsFor(tx, b.tenantId))).limits).toBe('LIMITS for everyone');

    // A stops using its own: back to the all-customers one. That stopped too: the original.
    await withPlatformScope((tx) => clearActivePrompt(tx, 'limits', a.tenantId));
    expect((await withTenant(a.tenantId, (tx) => promptsFor(tx, a.tenantId))).limits).toBe('LIMITS for everyone');
    await withPlatformScope((tx) => clearActivePrompt(tx, 'limits', null));
    expect((await withTenant(a.tenantId, (tx) => promptsFor(tx, a.tenantId))).limits).toBe(ORIGINAL.limits);
  });

  it('numbers versions per scope, goes back to an older one, and keeps one in use at a time', async () => {
    const a = await customer();
    const first = await save('leave', a.tenantId, 'leave one');
    const second = await save('leave', a.tenantId, 'leave two');
    expect([first.number, second.number]).toEqual([1, 2]);

    await withPlatformScope((tx) => activatePromptVersion(tx, first.id));
    const history = await withPlatformScope((tx) => promptHistory(tx, 'leave', a.tenantId));
    expect(history.own.map((v) => [v.number, v.active])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect((await withTenant(a.tenantId, (tx) => promptsFor(tx, a.tenantId))).leave).toBe('leave one');
  });

  it('deletes a version that is not in use, and refuses the one that is', async () => {
    const a = await customer();
    const first = await save('leave', a.tenantId, 'leave one');
    const second = await save('leave', a.tenantId, 'leave two');

    await expect(withPlatformScope((tx) => deletePromptVersion(tx, second.id))).rejects.toBeInstanceOf(PromptRefused);
    await withPlatformScope((tx) => deletePromptVersion(tx, first.id));
    const history = await withPlatformScope((tx) => promptHistory(tx, 'leave', a.tenantId));
    expect(history.own.map((v) => v.number)).toEqual([2]);
  });

  it('refuses an empty prompt', async () => {
    const a = await customer();
    await expect(save('leave', a.tenantId, '   \n ')).rejects.toBeInstanceOf(PromptRefused);
  });

  it("keeps one customer's versions from another, and lets no customer write any", async () => {
    const a = await customer();
    const b = await customer();
    await save('limits', a.tenantId, 'secret to A');

    const seenByB = await withTenant(b.tenantId, (tx) => tx.select().from(promptVersions).where(eq(promptVersions.prompt, 'limits')));
    expect(seenByB.some((v) => v.body === 'secret to A')).toBe(false);
    await expect(
      withTenant(b.tenantId, (tx) => tx.insert(promptVersions).values({ prompt: 'limits', tenantId: null, number: 99, body: 'x', active: true })),
    ).rejects.toThrow();
  });
});

describe('the agent', () => {
  it("talks with the customer's saved prompt", async () => {
    const a = await customer();
    await save('talking_agent', a.tenantId, 'HOW YOU TALK\n- Always mention the HR helpdesk by name.');

    let system = '';
    const model: NonNullable<TalkArgs['model']> = async (request, onDelta) => {
      system = (request.messages as { role: string; content: string }[])[0]!.content;
      const json = JSON.stringify({
        reply_language: 'en-IN',
        reply: 'Hello.',
        action: 'continue',
        outcome: 'none',
        leave_choice: 'not_said',
        application: 'not_said',
        leave_type: null,
        follow_up: 'none',
        handover_reason: null,
        note: null,
        per_date: [],
      });
      onDelta(json);
      return { raw: json, usage: { prompt_tokens: 10, completion_tokens: 5 } };
    };

    await withTenant(a.tenantId, async (tx) => {
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, a.employeeId) });
      prepareGrounding('prompt-test', async () => ({ passages: [], attendance: '' }));
      await talkTurn(
        a.context(tx),
        { mode: 'inbound', employee: employee!, call: null, caseRow: null, said: 'hello there, a question', history: [], preparedKey: 'prompt-test', model },
        () => {},
      );
    });

    // On a call, spelt out for the voice, between the fixed parts.
    expect(system).toContain('Always mention the H R helpdesk by name.');
    expect(system).not.toContain('NEVER GO ROUND IN CIRCLES');
    expect(system).toContain('OUTCOMES, AND WHAT THE EMPLOYEE IS TOLD AT EACH');
  });
});
