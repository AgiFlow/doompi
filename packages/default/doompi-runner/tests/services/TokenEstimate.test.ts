import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../src/services/TokenEstimate/tokenEstimate';

describe('estimateTokens', () => {
  it('returns nothing for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('charges dense scripts far more per character than prose', () => {
    const prose = 'the quick brown fox jumps over the lazy dog';
    const cjk = '这是一个很长的中文日志行用来测试分词';

    // Roughly equal character counts, very different token cost.
    expect(estimateTokens(cjk) / cjk.length).toBeGreaterThan((estimateTokens(prose) / prose.length) * 3);
  });

  it('charges runs mixing letters and digits more than words', () => {
    const words = 'alpha bravo charlie delta echo foxtrot';
    const mixed = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8';

    expect(estimateTokens(mixed)).toBeGreaterThan(estimateTokens(words));
  });

  /**
   * The calibration that matters: measured against `gpt-tokenizer` the worst
   * error is a factor of about 1.46, so these bounds are deliberately loose.
   * They exist to catch a change that breaks the shape, not to pin exact counts.
   */
  it.each([
    ['  compiled src/module-42.ts\n'.repeat(60), 480],
    ['The quick brown fox jumps over the lazy dog and keeps running for a while. '.repeat(20), 321],
    ['    at Object.<anonymous> (/Users/x/project/src/index.ts:42:17)\n'.repeat(25), 450],
  ])('stays within a factor of 1.6 of the real count', (text, real) => {
    const estimate = estimateTokens(text);
    expect(estimate).toBeGreaterThan(real / 1.6);
    expect(estimate).toBeLessThan(real * 1.6);
  });
});
