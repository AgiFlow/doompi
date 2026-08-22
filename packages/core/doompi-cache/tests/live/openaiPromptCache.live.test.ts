import { describe, expect, it } from 'vitest';
import { sha256Base64Url } from '../../src/adapters/node/digest.ts';
import { createParentPromptCacheNamespace, createPromptCacheKey } from '../../src/services/namespace.ts';
import type { PromptCacheParentState } from '../../src/types/cache.ts';

interface OpenAiResponse {
  id?: string;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

const enabled = process.env.DOOMPI_CACHE_LIVE_OPENAI === '1';

function state(majorMode: string): PromptCacheParentState {
  return {
    rootSessionId: process.env.DOOMPI_CACHE_LIVE_ROOT ?? 'live-canary-root',
    compositionFingerprint: 'live-canary-v1',
    majorMode,
    domains: ['cache-canary'],
    minorModes: [],
  };
}

async function request(apiKey: string, model: string, majorMode: string): Promise<OpenAiResponse> {
  const namespace = createParentPromptCacheNamespace(state(majorMode), sha256Base64Url);
  const key = createPromptCacheKey(namespace, 'parent', `live:${model}`, sha256Base64Url);
  const stableContext = Array.from(
    { length: 700 },
    (_, index) =>
      `Prompt-cache canary context ${index}: retain this deterministic sentence for provider cache testing.`,
  ).join('\n');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions: `${stableContext}\nCurrent major mode: ${majorMode}.`,
      input: 'Reply with the single word OK.',
      max_output_tokens: 16,
      prompt_cache_key: key,
      prompt_cache_retention: '24h',
      store: false,
    }),
  });
  const body = (await response.json()) as OpenAiResponse & { error?: unknown };
  if (!response.ok) throw new Error(`OpenAI cache canary failed (${response.status}): ${JSON.stringify(body.error)}`);
  return body;
}

describe.skipIf(!enabled)('live official OpenAI prompt cache canary', () => {
  it('reports provider-observed cache reads after an A to B to A transition without using them as a CI gate', async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.DOOMPI_CACHE_LIVE_OPENAI_MODEL;
    if (!apiKey || !model)
      throw new Error('Set OPENAI_API_KEY and DOOMPI_CACHE_LIVE_OPENAI_MODEL for the live canary.');

    const results = [
      await request(apiKey, model, 'state-a'),
      await request(apiKey, model, 'state-b'),
      await request(apiKey, model, 'state-a'),
    ];
    const observations = results.map((result, index) => ({
      request: index + 1,
      inputTokens: result.usage?.input_tokens ?? 0,
      cacheRead: result.usage?.input_tokens_details?.cached_tokens ?? 0,
    }));

    process.stdout.write(`[doompi-cache live canary] ${JSON.stringify(observations)}\n`);
    expect(results.every((result) => typeof result.id === 'string')).toBe(true);
  }, 120_000);
});
