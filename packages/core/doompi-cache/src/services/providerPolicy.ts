import type { PromptCacheCapabilityClass, PromptCacheModelIdentity } from '../types/cache.ts';

const ROUTING_KEY_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
]);

const MARKER_APIS = new Set(['anthropic-messages', 'bedrock-converse-stream']);
const AUTOMATIC_APIS = new Set(['google-generative-ai', 'google-vertex', 'google-vertex-anthropic']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function classifyPromptCacheCapability(model: PromptCacheModelIdentity): PromptCacheCapabilityClass {
  if (model.api === 'openai-responses' || model.api === 'openai-completions') {
    return model.virtualProvider === 'openai' ? 'key-and-long-retention' : 'key-only';
  }
  if (model.api && ROUTING_KEY_APIS.has(model.api)) return 'key-only';
  if (model.api && MARKER_APIS.has(model.api)) return 'marker-only';
  if (model.api && AUTOMATIC_APIS.has(model.api)) return 'automatic';
  return 'unknown';
}

export function rewritePromptCacheKey(
  payload: unknown,
  api: string | undefined,
  key: string,
  enabled: boolean,
): Record<string, unknown> | undefined {
  if (!enabled || !api || !ROUTING_KEY_APIS.has(api) || !isRecord(payload)) return undefined;
  const current = payload.prompt_cache_key;
  if (typeof current !== 'string' || !current.trim() || current === key) return undefined;
  return { ...payload, prompt_cache_key: key };
}

export function requestedPromptCacheRetention(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const retention = payload.prompt_cache_retention;
  return typeof retention === 'string' && retention.trim() ? retention.trim() : undefined;
}
