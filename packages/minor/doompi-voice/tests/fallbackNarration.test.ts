import { MAX_NARRATION_TEXT_CHARACTERS } from '@agimon-ai/doompi-extension-contracts/narration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveVoiceFallbackNarrator } from '../src/adapters/pi/voice.ts';
import {
  DETERMINISTIC_FALLBACK_THRESHOLD_CHARACTERS,
  type FallbackNarrationModelRequest,
  VoiceTurnFallbackNarrator,
} from '../src/services/fallbackNarration.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('Voice turn fallback narration', () => {
  it('uses deterministic sanitized speech for short final responses', async () => {
    const complete = vi.fn(async () => '{"speech":"unused"}');
    const narrator = new VoiceTurnFallbackNarrator({ complete });

    const result = await narrator.create(
      'Done. See **the result** at /Users/example/private.md with token=abcdefghijklmnop.',
      new AbortController().signal,
    );

    expect(result.source).toBe('deterministic');
    expect(result.text).toContain('Done. See the result at a file path');
    expect(result.text).toContain('a private value');
    expect(result.text).not.toContain('/Users');
    expect(result.text).not.toContain('abcdefghijklmnop');
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses the configured narrator model for long responses', async () => {
    const complete = vi.fn(async (_request: FallbackNarrationModelRequest) =>
      JSON.stringify({ speech: 'The detailed result is ready for review.' }),
    );
    const narrator = new VoiceTurnFallbackNarrator({ complete });
    const finalResponse = 'A substantive implementation result was completed successfully. '.repeat(12);

    await expect(narrator.create(finalResponse, new AbortController().signal)).resolves.toEqual({
      text: 'The detailed result is ready for review.',
      source: 'model',
    });

    expect(Array.from(finalResponse).length).toBeGreaterThan(DETERMINISTIC_FALLBACK_THRESHOLD_CHARACTERS);
    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]![0];
    expect(request).toMatchObject({ maxTokens: 192, cacheRetention: 'none' });
    expect(request.systemPrompt).toContain('untrusted data');
    expect(request.systemPrompt).toContain('one JSON object');
    expect(JSON.parse(request.input)).toEqual({ finalResponse: finalResponse.trim() });
  });

  it('bounds sanitized model input to the shared narration limit', async () => {
    const complete = vi.fn(async (_request: FallbackNarrationModelRequest) =>
      JSON.stringify({ speech: 'A concise bounded summary.' }),
    );
    const narrator = new VoiceTurnFallbackNarrator({ complete });

    await narrator.create('Long safe detail. '.repeat(1_000), new AbortController().signal);

    const input = JSON.parse(complete.mock.calls[0]![0].input) as { finalResponse: string };
    expect(Array.from(input.finalResponse).length).toBe(MAX_NARRATION_TEXT_CHARACTERS);
  });

  it('falls back to a bounded deterministic excerpt when model generation fails', async () => {
    const generationError = new Error('model unavailable');
    const complete = vi.fn(async () => Promise.reject(generationError));
    const narrator = new VoiceTurnFallbackNarrator({ complete });
    const finalResponse = 'Long written detail with important context. '.repeat(20);

    const result = await narrator.create(finalResponse, new AbortController().signal);

    expect(result.source).toBe('model-fallback');
    expect(result.generationError).toBe(generationError);
    expect(result.text).toContain('Please see the written response for the remaining details.');
    expect(Array.from(result.text).length).toBeLessThanOrEqual(DETERMINISTIC_FALLBACK_THRESHOLD_CHARACTERS);
  });

  it('uses the configured Pi model bridge without cache retention, retries, or reasoning', async () => {
    const complete = vi.fn(async (..._args: unknown[]) => ({
      stopReason: 'stop',
      content: [{ type: 'text', text: '{"speech":"The fallback summary is ready."}' }],
    }));
    const narrator = resolveVoiceFallbackNarrator('provider/model', {
      modelRegistry: {
        find: () => ({ provider: 'provider', id: 'model', api: 'test' }),
        hasConfiguredAuth: () => true,
        complete,
      },
    } as never);

    await expect(narrator.create('Long final response. '.repeat(40), new AbortController().signal)).resolves.toEqual({
      text: 'The fallback summary is ready.',
      source: 'model',
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0]?.[2]).toMatchObject({
      cacheRetention: 'none',
      reasoningEffort: 'none',
      maxRetries: 0,
      maxTokens: 192,
    });
  });

  it('rejects unavailable and unauthenticated configured Pi models', () => {
    const missing = { modelRegistry: { find: () => undefined } };
    expect(() => resolveVoiceFallbackNarrator('provider/model', missing as never)).toThrow(
      'Voice fallback narration model is not registered: provider/model',
    );

    const unauthenticated = {
      modelRegistry: {
        find: () => ({ provider: 'provider', id: 'model', api: 'test' }),
        hasConfiguredAuth: () => false,
      },
    };
    expect(() => resolveVoiceFallbackNarrator('provider/model', unauthenticated as never)).toThrow(
      'Voice fallback narration model has no configured authentication: provider/model',
    );
  });

  it('sanitizes model speech and rejects malformed payloads into the deterministic fallback', async () => {
    const secret = ['sk', 'live', 'abcdefghijklmnop'].join('_');
    const unsafe = new VoiceTurnFallbackNarrator({
      complete: vi.fn(async () => JSON.stringify({ speech: `Ready at /private/result with ${secret}` })),
    });
    const unsafeResult = await unsafe.create('Long result. '.repeat(40), new AbortController().signal);
    expect(unsafeResult).toMatchObject({ source: 'model' });
    expect(unsafeResult.text).not.toContain('/private');
    expect(unsafeResult.text).not.toContain('abcdefghijklmnop');

    const malformed = new VoiceTurnFallbackNarrator({ complete: vi.fn(async () => 'not json') });
    const malformedResult = await malformed.create('Long result. '.repeat(40), new AbortController().signal);
    expect(malformedResult.source).toBe('model-fallback');
    expect(malformedResult.generationError).toBeInstanceOf(Error);
  });

  it('propagates caller cancellation and aborts the model request', async () => {
    let modelSignal: AbortSignal | undefined;
    const narrator = new VoiceTurnFallbackNarrator({
      complete: vi.fn((request: FallbackNarrationModelRequest) => {
        modelSignal = request.signal;
        return new Promise<string>(() => undefined);
      }),
    });
    const controller = new AbortController();
    const narration = narrator.create('Long result. '.repeat(40), controller.signal);
    await Promise.resolve();

    controller.abort(new Error('session replaced'));

    await expect(narration).rejects.toThrow('session replaced');
    expect(modelSignal?.aborted).toBe(true);
  });

  it('bounds model latency and retains deterministic speech after timeout', async () => {
    vi.useFakeTimers();
    let modelSignal: AbortSignal | undefined;
    const narrator = new VoiceTurnFallbackNarrator(
      {
        complete: vi.fn((request: FallbackNarrationModelRequest) => {
          modelSignal = request.signal;
          return new Promise<string>(() => undefined);
        }),
      },
      { modelTimeoutMs: 25 },
    );
    const narration = narrator.create('Long result. '.repeat(40), new AbortController().signal);

    await vi.advanceTimersByTimeAsync(25);

    await expect(narration).resolves.toMatchObject({ source: 'model-fallback' });
    expect(modelSignal?.aborted).toBe(true);
  });
});
