export type PromptCacheCapabilityClass =
  | 'key-and-long-retention'
  | 'key-only'
  | 'marker-only'
  | 'automatic'
  | 'unknown';

export interface PromptCacheMinorModeState {
  readonly source: string;
  readonly id: string;
  readonly activation: string;
  readonly modelContextVariant?: string;
}

export interface PromptCacheParentState {
  readonly rootSessionId: string;
  readonly compositionFingerprint?: string;
  readonly majorMode: string;
  readonly domains: readonly string[];
  readonly profile?: string;
  readonly persona?: string;
  readonly minorModes: readonly PromptCacheMinorModeState[];
}

export interface PromptCacheChildProjection {
  readonly systemPrompt?: string;
  readonly tools: readonly string[];
  readonly excludedTools: readonly string[];
  readonly extensions: readonly string[];
  readonly inheritProjectContext?: boolean;
  readonly inheritSkills?: boolean;
  readonly fanout?: boolean;
  readonly structuredOutputSchema?: unknown;
}

export interface PromptCacheModelIdentity {
  readonly virtualProvider?: string;
  readonly virtualModel?: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly wireModel?: string;
}

export interface PromptCacheDigest {
  (value: string): string;
}

export interface PromptCacheUsage {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalInput: number;
}

export interface PromptCacheObservation extends PromptCacheUsage {
  readonly namespace: string;
  readonly modelFingerprint: string;
  readonly observedAt: number;
}

export interface PromptCacheRequestStatus {
  readonly capability: PromptCacheCapabilityClass;
  readonly namespace?: string;
  readonly modelFingerprint?: string;
  readonly requestedRetention?: string;
  readonly keySuffix?: string;
}

export interface PromptCacheTelemetrySnapshot extends PromptCacheRequestStatus {
  readonly residency: 'unknown';
  readonly observations: readonly PromptCacheObservation[];
  readonly lastObservation?: PromptCacheObservation;
}

export interface PromptCacheTelemetryPort {
  beginRequest(status: PromptCacheRequestStatus): void;
  observe(usage: PromptCacheUsage, observedAt: number): void;
  snapshot(): PromptCacheTelemetrySnapshot;
  reset(): void;
}
