import type {
  PromptCacheObservation,
  PromptCacheRequestStatus,
  PromptCacheTelemetryPort,
  PromptCacheTelemetrySnapshot,
  PromptCacheUsage,
} from '../types/cache.ts';

const DEFAULT_OBSERVATION_LIMIT = 64;

export class PromptCacheTelemetry implements PromptCacheTelemetryPort {
  readonly #limit: number;
  #request: PromptCacheRequestStatus = { capability: 'unknown' };
  #observations: PromptCacheObservation[] = [];

  constructor(limit: number = DEFAULT_OBSERVATION_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Prompt cache telemetry limit must be a positive integer.');
    this.#limit = limit;
  }

  beginRequest(status: PromptCacheRequestStatus): void {
    this.#request = { ...status };
  }

  observe(usage: PromptCacheUsage, observedAt: number): void {
    const namespace = this.#request.namespace;
    const modelFingerprint = this.#request.modelFingerprint;
    if (!namespace || !modelFingerprint) return;

    this.#observations.push({
      namespace,
      modelFingerprint,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalInput: usage.totalInput,
      observedAt,
    });
    if (this.#observations.length > this.#limit) {
      this.#observations.splice(0, this.#observations.length - this.#limit);
    }
  }

  snapshot(): PromptCacheTelemetrySnapshot {
    const observations = [...this.#observations];
    return {
      ...this.#request,
      residency: 'unknown',
      observations,
      ...(observations.length > 0 ? { lastObservation: observations.at(-1) } : {}),
    };
  }

  reset(): void {
    this.#request = { capability: 'unknown' };
    this.#observations = [];
  }
}
