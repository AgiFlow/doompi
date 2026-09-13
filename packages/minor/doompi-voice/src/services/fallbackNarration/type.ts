export interface FallbackNarrationModelRequest {
  systemPrompt: string;
  input: string;
  maxTokens: number;
  cacheRetention: 'none';
  signal: AbortSignal;
}

export interface IFallbackNarrationModelClient {
  complete(request: FallbackNarrationModelRequest): Promise<string>;
}

export type FallbackNarrationSource = 'deterministic' | 'model' | 'model-fallback';

export interface FallbackNarration {
  text: string;
  source: FallbackNarrationSource;
  generationError?: unknown;
}

export interface IVoiceTurnFallbackNarrator {
  create(finalResponse: string, signal: AbortSignal): Promise<FallbackNarration>;
}

export interface IVoiceNarrationCompactor {
  compact(narrations: readonly string[], signal: AbortSignal): Promise<string>;
}

export interface VoiceTurnFallbackNarratorOptions {
  deterministicThresholdCharacters?: number;
  modelTimeoutMs?: number;
}
