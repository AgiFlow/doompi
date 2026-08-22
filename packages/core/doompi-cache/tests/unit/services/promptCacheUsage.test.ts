import { describe, expect, it } from 'vitest';
import { normalizePromptCacheUsage } from '../../../src/services/promptCacheUsage.ts';

describe('provider-reported prompt cache usage', () => {
  it('normalizes Pi assistant usage without optimizer-private exports', () => {
    expect(normalizePromptCacheUsage({ usage: { input: 100, cacheRead: 20, cacheWrite: 5, output: 10 } })).toEqual({
      cacheRead: 20,
      cacheWrite: 5,
      totalInput: 125,
    });
  });

  it('normalizes OpenAI raw cached token details', () => {
    expect(
      normalizePromptCacheUsage({
        usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 300 } },
      }),
    ).toEqual({ cacheRead: 300, cacheWrite: 0, totalInput: 500 });
  });

  it('normalizes Anthropic and Gemini raw usage', () => {
    expect(
      normalizePromptCacheUsage({
        usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 },
      }),
    ).toEqual({ cacheRead: 200, cacheWrite: 50, totalInput: 350 });
    expect(
      normalizePromptCacheUsage({
        usage: { usage_metadata: { cachedContentTokenCount: 250, promptTokenCount: 400 } },
      }),
    ).toEqual({ cacheRead: 250, cacheWrite: 0, totalInput: 400 });
  });

  it('ignores messages without provider cache signals', () => {
    expect(normalizePromptCacheUsage({ usage: { input: 100, output: 20 } })).toBeUndefined();
    expect(normalizePromptCacheUsage({ usage: { cacheRead: -1 } })).toBeUndefined();
    expect(normalizePromptCacheUsage({})).toBeUndefined();
  });
});
