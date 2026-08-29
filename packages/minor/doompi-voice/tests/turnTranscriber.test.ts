import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnTranscriber } from '../src/services/turnTranscriber.ts';
import type { IClock } from '../src/types/index.ts';

const clock: IClock = {
  now: () => Date.now(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => clearTimeout(handle),
};

afterEach(() => vi.useRealTimers());

describe('TurnTranscriber', () => {
  it('returns one normalized successful transcript without retrying', async () => {
    const retryNormalized = vi.fn(async () => 'retry');
    const outcome = await new TurnTranscriber(clock).transcribe({
      transcribe: async () => '  exact user words  ',
      retryNormalized,
    });

    expect(outcome).toEqual({ kind: 'success', transcript: 'exact user words' });
    expect(retryNormalized).not.toHaveBeenCalled();
  });

  it('preserves generic ASR evidence from a structured adapter result', async () => {
    await expect(
      new TurnTranscriber(clock).transcribe({
        transcribe: async () => ({
          transcript: '  short command  ',
          evidence: { noSpeechProbability: 0.1, speechDurationMs: 300 },
        }),
      }),
    ).resolves.toEqual({
      kind: 'success',
      transcript: 'short command',
      evidence: { noSpeechProbability: 0.1, speechDurationMs: 300 },
    });
  });

  it('retains decoding evidence when both structured passes are empty', async () => {
    await expect(
      new TurnTranscriber(clock).transcribe({
        transcribe: async () => ({ transcript: '', evidence: { noSpeechProbability: 0.7 } }),
        retryNormalized: async () => ({ transcript: ' ', evidence: { noSpeechProbability: 0.9 } }),
      }),
    ).resolves.toEqual({ kind: 'empty', evidence: { noSpeechProbability: 0.9 } });
  });
  it('performs at most one normalized retry after an empty nonzero pass', async () => {
    const retryNormalized = vi.fn(async () => ' recovered words ');
    const outcome = await new TurnTranscriber(clock).transcribe({
      transcribe: async () => '',
      retryNormalized,
    });

    expect(outcome).toEqual({ kind: 'success', transcript: 'recovered words' });
    expect(retryNormalized).toHaveBeenCalledOnce();
  });

  it('returns empty without a configured normalized retry', async () => {
    await expect(new TurnTranscriber(clock).transcribe({ transcribe: async () => '  ' })).resolves.toEqual({
      kind: 'empty',
    });
  });

  it('aborts a hung adapter at the shared deadline', async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const pending = new TurnTranscriber(clock).transcribe({
      timeoutMs: 15_000,
      transcribe: (signal) => {
        observedSignal = signal;
        return new Promise<string>(() => undefined);
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toEqual({ kind: 'timeout' });
    expect(observedSignal?.aborted).toBe(true);
  });

  it('distinguishes caller cancellation from timeout', async () => {
    const controller = new AbortController();
    const pending = new TurnTranscriber(clock).transcribe({
      signal: controller.signal,
      transcribe: async () => new Promise<string>(() => undefined),
    });
    controller.abort();

    await expect(pending).resolves.toEqual({ kind: 'failure', code: 'transcription_aborted' });
  });
});
