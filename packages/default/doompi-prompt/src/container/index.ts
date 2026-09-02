import { createNodeSavedPromptStore } from '../adapters/node/promptStore.ts';
import { createRecentPrompts } from '../services/recentPrompts.ts';
import type { PromptExtensionDependencies } from '../types/prompt.ts';

/** Plain factory construction, with per-dependency overrides for tests. */
export function createPromptContainer(
  overrides: Partial<PromptExtensionDependencies> = {},
): PromptExtensionDependencies {
  return {
    store: overrides.store ?? createNodeSavedPromptStore(),
    recent: overrides.recent ?? createRecentPrompts(),
  };
}
