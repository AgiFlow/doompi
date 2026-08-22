export interface PromptCacheOptimizerRuntime {
  readonly __internals_for_tests?: {
    readonly isRuntimeOptimizerEnabled?: () => boolean;
    readonly shouldInjectOpenAIPromptCacheKey?: () => boolean;
  };
}

/** Fail closed unless the pinned optimizer confirms both runtime and key routing are enabled. */
export function optimizerAllowsPromptCacheKey(optimizer: PromptCacheOptimizerRuntime): boolean {
  const internals = optimizer.__internals_for_tests;
  return (
    typeof internals?.isRuntimeOptimizerEnabled === 'function' &&
    typeof internals.shouldInjectOpenAIPromptCacheKey === 'function' &&
    internals.isRuntimeOptimizerEnabled() &&
    internals.shouldInjectOpenAIPromptCacheKey()
  );
}
