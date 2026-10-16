import { describe, expect, it } from 'vitest';
import { ReplyExtractor } from '@/lib/knowledge';

/**
 * On a call the answer is spoken while the model is still writing it, so the
 * reply is read out of JSON that is not finished yet.
 */
const whole = JSON.stringify({
  finished: false,
  answered: true,
  reply: 'You have 4 days of "casual leave" left.\nApply by the 25th — café rules\\no exceptions.',
});
const reply = (JSON.parse(whole) as { reply: string }).reply;

function readInPieces(json: string, size: number): string {
  const extractor = new ReplyExtractor();
  let text = '';
  for (let i = 0; i < json.length; i += size) text += extractor.push(json.slice(i, i + size));
  return text;
}

describe('reading a reply as it streams', () => {
  it('gives the same text whatever size the pieces arrive in', () => {
    for (const size of [1, 2, 3, 5, 7, 13, whole.length]) expect(readInPieces(whole, size)).toBe(reply);
  });

  it('copes with a \\u escape cut in half', () => {
    const json = '{"finished":false,"answered":true,"reply":"caf\\u00e9 open"}';
    for (let cut = 1; cut < json.length; cut++) {
      const extractor = new ReplyExtractor();
      expect(extractor.push(json.slice(0, cut)) + extractor.push(json.slice(cut))).toBe('café open');
    }
  });

  it('hands text over before the JSON is finished', () => {
    const extractor = new ReplyExtractor();
    expect(extractor.push('{"finished":false,"answered":true,"reply":"Hello, ')).toBe('Hello, ');
    expect(extractor.push('there')).toBe('there');
  });

  it('ignores anything after the reply closes', () => {
    const extractor = new ReplyExtractor();
    expect(extractor.push('{"reply":"Done."}')).toBe('Done.');
    expect(extractor.push(' trailing "text"')).toBe('');
  });
});
