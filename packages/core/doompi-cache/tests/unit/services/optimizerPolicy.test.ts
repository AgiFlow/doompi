import { describe, expect, it, vi } from 'vitest';
import { optimizerAllowsPromptCacheKey } from '../../../src/services/optimizerPolicy.ts';

describe('optimizer runtime policy', () => {
  it('reads the pinned optimizer runtime helpers from its exported internals object', () => {
    expect(
      optimizerAllowsPromptCacheKey({
        __internals_for_tests: {
          isRuntimeOptimizerEnabled: () => true,
          shouldInjectOpenAIPromptCacheKey: () => true,
        },
      }),
    ).toBe(true);
  });

  it('fails closed when runtime helpers are absent or either policy is disabled', () => {
    expect(optimizerAllowsPromptCacheKey({})).toBe(false);
    expect(
      optimizerAllowsPromptCacheKey({
        __internals_for_tests: {
          isRuntimeOptimizerEnabled: () => false,
          shouldInjectOpenAIPromptCacheKey: vi.fn(() => true),
        },
      }),
    ).toBe(false);
    expect(
      optimizerAllowsPromptCacheKey({
        __internals_for_tests: {
          isRuntimeOptimizerEnabled: () => true,
          shouldInjectOpenAIPromptCacheKey: () => false,
        },
      }),
    ).toBe(false);
  });
});
