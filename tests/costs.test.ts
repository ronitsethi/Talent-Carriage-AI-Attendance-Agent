import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '@/db';
import { calls, cases, costLines, messages } from '@/db/schema';
import { runDailyCheck } from '@/lib/detection/run';
import { applyDeliveryUpdate } from '@/lib/conversation/engine';
import { callCostLines, recordCallCosts } from '@/lib/costs/calls';
import { flushCosts, noteModelCost, withCostScope } from '@/lib/costs/record';
import { caseCostBox, whatsappFee } from '@/lib/costs/summary';
import { applyPlivoCharge } from '@/lib/costs/plivo';
import { env } from '@/lib/env';
import { giveAttendance, makeScenario, type Scenario } from './helpers/scenario';

/**
 * What a call or a message cost, item by item, as shown under its transcript.
 */

let scenario: Scenario;
afterEach(async () => {
  await flushCosts();
  await scenario?.cleanup();
});

const rupees = (micros: number | null) => (micros === null ? null : micros / 1_000_000);

describe('a call\'s own costs', () => {
  it('charges a keypad call the seconds Plivo billed at the rupee rate, not its dollar amount, and adds the answers it recognised', () => {
    // Aryan's call on 27 Oct: Plivo's console shows 60s billed, ₹0.38; its API says $0.0047.
    const lines = callCostLines({
      provider: 'plivo',
      durationSeconds: 44,
      plivoCharge: { usdAmount: 0.0047, billedSeconds: 60 },
      spokenAnswers: 2,
    });
    expect(lines[0]!.detail).toMatchObject({ plivoUsd: 0.0047 });
    expect(lines.map((l) => [l.item, rupees(l.amountMicros), l.estimated ?? true])).toEqual([
      ['Phone call', 0.38, false],
      ['Speech recognition (answers spoken, not pressed)', 3.4, true],
      ['Recording', 0, true],
    ]);
  });

  it('works a keypad call out from its length when Plivo does not say, in 30-second pulses', () => {
    const [line] = callCostLines({ provider: 'plivo', durationSeconds: 61 });
    // 61 seconds is three pulses of 30: 90 seconds at ₹0.38 a minute.
    expect(line).toMatchObject({ quantity: 90, unit: 'seconds' });
    expect(rupees(line!.amountMicros)).toBeCloseTo(0.57, 6);
  });

  it('prices a talking call\'s line, LiveKit\'s minutes and the speech both ways', () => {
    const lines = callCostLines({
      provider: 'livekit',
      durationSeconds: 125,
      worker: { sttSeconds: 40, sttModel: 'Sarvam streaming', ttsCharacters: 1500, ttsModel: 'bulbul:v3-beta' },
    });
    const by = Object.fromEntries(lines.map((l) => [l.item, l]));
    expect(rupees(by['Phone line, over the SIP trunk']!.amountMicros)).toBeCloseTo(5 * 0.19, 6);
    // LiveKit's Build plan, the default: free within its monthly minutes.
    expect(by['SIP participant minutes']).toMatchObject({ quantity: 3, currency: 'USD', amountMicros: 0 });
    expect(by['Agent connection (WebRTC minutes)']).toMatchObject({ quantity: 3, amountMicros: 0 });
    // Streaming speech to text hears the whole call, not only the 40 seconds of words.
    expect(by['Speech to text (Sarvam streaming)']).toMatchObject({ quantity: 125 });
    expect(rupees(by['Speech to text (Sarvam streaming)']!.amountMicros)).toBeCloseTo((125 / 3600) * 30, 6);
    expect(rupees(by['Text to speech (bulbul:v3-beta)']!.amountMicros)).toBeCloseTo(4.5, 6);
  });

  it('costs nothing when nobody picked up', () => {
    expect(callCostLines({ provider: 'plivo', durationSeconds: 0 })).toEqual([]);
  });
});

describe('a WhatsApp message\'s fee', () => {
  const sent = { direction: 'outbound' as const, status: 'delivered' as const, templateName: null, pricing: null };

  it('charges a template as a utility message until the receipt says otherwise', () => {
    expect(whatsappFee({ ...sent, kind: 'template', templateName: 'attendance_absent_v2' })).toMatchObject({ inr: 0.115, estimated: true });
    expect(whatsappFee({ ...sent, kind: 'template', pricing: { billable: false, type: 'free_entry_point' } })).toMatchObject({ inr: 0 });
    expect(whatsappFee({ ...sent, kind: 'text', pricing: { billable: true, category: 'service' } })).toMatchObject({ inr: 0.115 });
  });

  it('charges nothing for a reply inside the free tier, a dry run, or one that never arrived', () => {
    expect(whatsappFee({ ...sent, kind: 'text' })).toMatchObject({ inr: 0 });
    expect(whatsappFee({ ...sent, kind: 'template', status: 'simulated' })).toMatchObject({ inr: 0 });
    expect(whatsappFee({ ...sent, kind: 'template', status: 'failed' })).toMatchObject({ inr: 0 });
    expect(whatsappFee({ ...sent, direction: 'inbound', kind: 'text' })).toMatchObject({ item: 'Received message', inr: 0 });
  });
});

describe('the boxes under the transcripts', () => {
  async function oneAbsence() {
    scenario = await makeScenario();
    return withTenant(scenario.tenantId, async (tx) => {
      await giveAttendance(tx, scenario.tenantId, scenario.employeeId, [{ date: '2026-09-21', meaning: 'absent_full', raw: 'A' }]);
      await runDailyCheck(scenario.context(tx), { date: '2026-09-21', trigger: 'manual' });
      return (await tx.select().from(cases))[0]!;
    });
  }

  it('adds up a case by service: WhatsApp counted by kind, and the AI by what it was for', async () => {
    const caseRow = await oneAbsence();
    const reply = 'wamid.reply-1';
    await withTenant(scenario.tenantId, async (tx) => {
      await tx.insert(messages).values({
        tenantId: scenario.tenantId, caseId: caseRow.id, direction: 'inbound', channel: 'whatsapp', kind: 'text',
        status: 'received', providerMessageId: reply, waId: scenario.mobile, body: 'I was unwell',
      });
    });
    // As the webhook does: what answering a message costs is written against it.
    withCostScope({ tenantId: scenario.tenantId, providerMessageId: reply }, () =>
      noteModelCost('openai', 'gpt-4.1-mini', { inputTokens: 2_000, outputTokens: 100 }, 'Chat reply'),
    );
    withCostScope({ tenantId: scenario.tenantId, caseId: caseRow.id }, () => {
      noteModelCost('openai', 'gpt-4.1-mini', { inputTokens: 400, outputTokens: 60 }, 'Summary');
      noteModelCost('openai', 'gpt-4.1-mini', { inputTokens: 500, outputTokens: 70 }, 'Summary');
    });
    await flushCosts();

    await withTenant(scenario.tenantId, async (tx) => {
      const [template] = await tx.select().from(messages).where(eq(messages.direction, 'outbound'));
      await tx.update(messages).set({ status: 'sent', providerMessageId: 'wamid.first' }).where(eq(messages.id, template!.id));
      await applyDeliveryUpdate(tx, scenario.tenantId, {
        providerMessageId: 'wamid.first', status: 'delivered', at: new Date(), pricing: { billable: true, category: 'utility', type: 'regular' },
      });

      const chat = await tx.select().from(messages).where(eq(messages.caseId, caseRow.id));
      const box = await caseCostBox(tx, caseRow.id, chat, []);
      expect(box.groups.map((g) => g.title)).toEqual(['WhatsApp', 'AI (Azure OpenAI)']);

      const whatsapp = box.groups[0]!;
      expect(whatsapp.rows).toEqual([
        expect.objectContaining({ item: 'Templates sent to the employee', quantity: '1 message', inr: 0.115, note: '1 charged at ₹0.115 each' }),
        expect.objectContaining({ item: 'Messages received', quantity: '1 message', inr: 0 }),
      ]);
      const ai = box.groups[1]!;
      // The biggest first.
      expect(ai.rows).toEqual([
        expect.objectContaining({ item: 'Chat reply (gpt-4.1-mini)', quantity: '2,100 tokens' }),
        expect.objectContaining({ item: 'Summary (gpt-4.1-mini)', quantity: '1,030 tokens · 2 requests' }),
      ]);
      // 3,000 in at $0.40/M and 230 out at $1.60/M, in rupees.
      expect(ai.inr).toBeCloseTo(((2_900 * 0.4 + 230 * 1.6) / 1_000_000) * 88, 8);
      expect(box.inr).toBeCloseTo(ai.inr + 0.115, 8);
    });
  });

  it('counts a call\'s minutes and speech under their services, once however often the end is reported', async () => {
    const caseRow = await oneAbsence();
    await withTenant(scenario.tenantId, async (tx) => {
      const [call] = await tx
        .insert(calls)
        .values({ tenantId: scenario.tenantId, caseId: caseRow.id, employeeId: scenario.employeeId, provider: 'livekit', status: 'completed', transcript: [] })
        .returning();
      withCostScope({ tenantId: scenario.tenantId, callId: call!.id }, () =>
        noteModelCost('openai', 'gpt-4.1-mini', { inputTokens: 1_000, outputTokens: 50 }, 'Conversation reply'),
      );
      withCostScope({ tenantId: scenario.tenantId, callId: call!.id }, () =>
        noteModelCost('openai', 'gpt-4.1-mini', { inputTokens: 1_200, outputTokens: 60 }, 'Conversation reply'),
      );
      await flushCosts();
      const report = { provider: 'livekit', durationSeconds: 60, worker: { ttsCharacters: 500 } };
      await recordCallCosts(tx, scenario.tenantId, { callId: call!.id, caseId: caseRow.id }, report);
      await recordCallCosts(tx, scenario.tenantId, { callId: call!.id, caseId: caseRow.id }, report);

      const box = await caseCostBox(tx, caseRow.id, [], [call!.id]);
      expect(box.groups.map((g) => g.title)).toEqual(['AI (Azure OpenAI)', 'Speech (Sarvam)', 'Phone line (Plivo)', 'Talking calls (LiveKit)']);
      const livekit = box.groups.find((g) => g.title === 'Talking calls (LiveKit)')!;
      expect(livekit.rows.filter((r) => r.item === 'SIP participant minutes')).toHaveLength(1);
      // The two turns read as one row.
      expect(box.groups[0]!.rows).toEqual([expect.objectContaining({ item: 'Conversation reply (gpt-4.1-mini)', quantity: '2,310 tokens · 2 requests' })]);
      expect(box.estimated).toBe(true);
      expect(box.inr).toBeGreaterThan(0);
    });
  });

  it('writes nothing outside a conversation, such as importing a file', async () => {
    scenario = await makeScenario();
    noteModelCost('openai', 'gpt-4.1-mini', { inputTokens: 5_000, outputTokens: 0 }, 'Mapping suggestion');
    await flushCosts();
    const written = await withTenant(scenario.tenantId, (tx) => tx.select().from(costLines));
    expect(written).toEqual([]);
  });
});

describe("Plivo's own charge for a talking call", () => {
  it('replaces the worked-out trunk line with the call record Plivo keeps', async () => {
    scenario = await makeScenario();
    const started = new Date('2026-10-26T13:45:00Z');
    const callId = '00000000-0000-4000-8000-000000000001';
    await withTenant(scenario.tenantId, (tx) =>
      recordCallCosts(tx, scenario.tenantId, { callId }, { provider: 'livekit', durationSeconds: 70 }),
    );
    Object.assign(env, { PLIVO_AUTH_ID: 'MAID', PLIVO_AUTH_TOKEN: 'secret' });
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: URL) => {
      asked.push(String(url));
      return new Response(
        JSON.stringify({
          objects: [
            { call_uuid: 'other', initiation_time: '2026-10-26 09:00:00', total_amount: '0.95', bill_duration: 150 },
            // Jeet's call on 28 Oct: the console shows 210s billed, ₹1.33; the API gives dollars.
            { call_uuid: 'ours', initiation_time: '2026-10-26 13:45:04', total_amount: '0.017', bill_duration: 210 },
          ],
        }),
        { status: 200 },
      );
    });
    try {
      const result = await applyPlivoCharge({
        tenantId: scenario.tenantId, key: `call:${callId}`, via: 'trunk', number: '919718290560', direction: 'outbound', startedAt: started.toISOString(),
      });
      expect(result).toMatchObject({ found: true, amount: 0.017, lines: 1 });
      expect(asked[0]).toContain('/Zentrunk/Call/');
      expect(asked[0]).toContain('to_number=919718290560');
    } finally {
      vi.unstubAllGlobals();
      Object.assign(env, { PLIVO_AUTH_ID: undefined, PLIVO_AUTH_TOKEN: undefined });
    }
    const box = await withTenant(scenario.tenantId, (tx) => caseCostBox(tx, '00000000-0000-4000-8000-0000000000ff', [], [callId]));
    expect(box.groups.find((g) => g.title === 'Phone line (Plivo)')!.rows[0]).toMatchObject({ inr: 1.33, estimated: false, note: 'Plivo call record ours: 210s billed at ₹0.38/min' });
  });
});
