import type { PromptCacheTelemetryPort } from './cache.ts';

export interface CacheExtensionDependencies {
  readonly telemetry: PromptCacheTelemetryPort;
  readonly now: () => number;
}
