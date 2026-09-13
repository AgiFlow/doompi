import type { PromptCacheTelemetryPort } from './cache';

export interface CacheExtensionDependencies {
  readonly telemetry: PromptCacheTelemetryPort;
  readonly now: () => number;
}
