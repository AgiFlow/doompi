import type { PromptCacheUsage } from '../types/cache.ts';

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const number = nonNegativeNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function normalizedUsage(usage: Readonly<Record<string, unknown>>): PromptCacheUsage | undefined {
  const cacheRead = nonNegativeNumber(usage.cacheRead);
  const cacheWrite = nonNegativeNumber(usage.cacheWrite);
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;
  const input = nonNegativeNumber(usage.input) ?? 0;
  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

function openAiUsage(usage: Readonly<Record<string, unknown>>): PromptCacheUsage | undefined {
  const promptDetails = recordValue(usage.prompt_tokens_details) ?? recordValue(usage.promptTokensDetails);
  const inputDetails = recordValue(usage.input_tokens_details) ?? recordValue(usage.inputTokensDetails);
  const cacheRead = firstNumber(
    promptDetails?.cached_tokens,
    promptDetails?.cachedTokens,
    inputDetails?.cached_tokens,
    inputDetails?.cachedTokens,
  );
  const cacheWrite = firstNumber(
    promptDetails?.cache_write_tokens,
    promptDetails?.cacheWriteTokens,
    inputDetails?.cache_write_tokens,
    inputDetails?.cacheWriteTokens,
  );
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;
  const floor = (cacheRead ?? 0) + (cacheWrite ?? 0);
  const reportedTotal = firstNumber(usage.prompt_tokens, usage.promptTokens, usage.input_tokens, usage.inputTokens);
  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: Math.max(reportedTotal ?? floor, floor),
  };
}

function anthropicUsage(usage: Readonly<Record<string, unknown>>): PromptCacheUsage | undefined {
  const cacheRead = firstNumber(usage.cache_read_input_tokens, usage.cacheReadInputTokens);
  const cacheWrite = firstNumber(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  if (cacheRead === undefined && cacheWrite === undefined) return undefined;
  const input = firstNumber(usage.input_tokens, usage.inputTokens) ?? 0;
  return {
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalInput: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

function geminiUsage(usage: Readonly<Record<string, unknown>>): PromptCacheUsage | undefined {
  const metadata = recordValue(usage.usage_metadata) ?? recordValue(usage.usageMetadata) ?? usage;
  const cacheRead = firstNumber(metadata.cachedContentTokenCount, metadata.cached_content_token_count);
  if (cacheRead === undefined) return undefined;
  const totalInput = firstNumber(
    metadata.promptTokenCount,
    metadata.prompt_token_count,
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens,
  );
  return { cacheRead, cacheWrite: 0, totalInput: Math.max(totalInput ?? cacheRead, cacheRead) };
}

/** Normalize only usage values carried by a provider-produced assistant message. */
export function normalizePromptCacheUsage(message: unknown): PromptCacheUsage | undefined {
  const messageRecord = recordValue(message);
  const usage = recordValue(messageRecord?.usage);
  if (!usage) return undefined;
  return normalizedUsage(usage) ?? openAiUsage(usage) ?? anthropicUsage(usage) ?? geminiUsage(usage);
}
