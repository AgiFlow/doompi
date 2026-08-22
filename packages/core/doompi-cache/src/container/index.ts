import { PromptCacheTelemetry } from '../services/telemetry.ts';
import type { CacheExtensionDependencies } from '../types/extension.ts';

export function createCacheContainer(overrides: Partial<CacheExtensionDependencies> = {}): CacheExtensionDependencies {
  return {
    telemetry: overrides.telemetry ?? new PromptCacheTelemetry(),
    now: overrides.now ?? Date.now,
  };
}
