import { describe, expect, it } from 'vitest';
import {
  classifyPromptCacheCapability,
  requestedPromptCacheRetention,
  rewritePromptCacheKey,
} from '../../../src/services/providerPolicy.ts';

describe('provider prompt cache policy', () => {
  it.each([
    [{ virtualProvider: 'openai', api: 'openai-responses' }, 'key-and-long-retention'],
    [{ virtualProvider: 'openai', api: 'openai-completions' }, 'key-and-long-retention'],
    [{ virtualProvider: 'openai-codex', api: 'openai-codex-responses' }, 'key-only'],
    [{ virtualProvider: 'azure', api: 'azure-openai-responses' }, 'key-only'],
    [{ virtualProvider: 'anthropic', api: 'anthropic-messages' }, 'marker-only'],
    [{ virtualProvider: 'bedrock', api: 'bedrock-converse-stream' }, 'marker-only'],
    [{ virtualProvider: 'google', api: 'google-generative-ai' }, 'automatic'],
    [{ virtualProvider: 'unknown', api: 'custom' }, 'unknown'],
  ] as const)('classifies %o as %s', (model, expected) => {
    expect(classifyPromptCacheCapability(model)).toBe(expected);
  });

  it.each(['openai-responses', 'openai-completions', 'openai-codex-responses', 'azure-openai-responses'])(
    'replaces an existing nonblank key for %s',
    (api) => {
      const payload = { prompt_cache_key: 'pi-session', model: 'wire-model', nested: { unchanged: true } };
      expect(rewritePromptCacheKey(payload, api, 'dpc1_replacement', true)).toEqual({
        ...payload,
        prompt_cache_key: 'dpc1_replacement',
      });
      expect(payload.prompt_cache_key).toBe('pi-session');
    },
  );

  it('does not inject fields into unknown proxies or requests without an existing key', () => {
    expect(rewritePromptCacheKey({ model: 'proxy-model' }, 'openai-responses', 'dpc1_key', true)).toBeUndefined();
    expect(
      rewritePromptCacheKey({ prompt_cache_key: 'proxy-key' }, 'custom-openai-compatible', 'dpc1_key', true),
    ).toBeUndefined();
    expect(
      rewritePromptCacheKey({ prompt_cache_key: 'pi-key' }, 'anthropic-messages', 'dpc1_key', true),
    ).toBeUndefined();
  });

  it('honors optimizer key disable and observes retention without modifying it', () => {
    const payload = { prompt_cache_key: 'pi-key', prompt_cache_retention: '24h' };
    expect(rewritePromptCacheKey(payload, 'openai-responses', 'dpc1_key', false)).toBeUndefined();
    expect(requestedPromptCacheRetention(payload)).toBe('24h');
    expect(requestedPromptCacheRetention({ prompt_cache_retention: '' })).toBeUndefined();
  });
});
