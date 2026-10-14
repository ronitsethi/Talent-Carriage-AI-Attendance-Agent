import { describe, expect, it } from 'vitest';
import { costMicros } from '@/lib/models/budget';

/**
 * The WhatsApp and call allowances are counted from the tokens each response
 * reports, at Azure's list price, in micro-dollars.
 */
describe('what a model response costs', () => {
  it('prices gpt-4.1-mini input and output separately', () => {
    // 1,000 in at $0.40/M and 200 out at $1.60/M is $0.00072.
    expect(costMicros('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 200 })).toBe(720);
  });

  it('recognises the dated model name Azure reports back', () => {
    expect(costMicros('gpt-4.1-mini-2025-04-14', { inputTokens: 1_000_000 })).toBe(400_000);
  });

  it('prices embeddings', () => {
    expect(costMicros('text-embedding-3-small', { inputTokens: 50_000 })).toBe(1000);
  });

  it('charges an unknown model rather than letting it through free', () => {
    expect(costMicros('some-new-model', { inputTokens: 1000 })).toBe(400);
  });

  it('never rounds a tiny reply down to nothing', () => {
    expect(costMicros('text-embedding-3-small', { inputTokens: 3 })).toBe(1);
  });
});
