declare module '#doompi-cache-optimizer-source' {
  import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

  export const __internals_for_tests: {
    readonly isRuntimeOptimizerEnabled?: () => boolean;
    readonly shouldInjectOpenAIPromptCacheKey?: () => boolean;
  };
  const cacheOptimizerExtension: (pi: ExtensionAPI) => void | Promise<void>;
  export default cacheOptimizerExtension;
}
