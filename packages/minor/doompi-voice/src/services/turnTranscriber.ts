import type { IClock, TimerHandle } from '../types/index.ts';

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15_000;

export type TurnTranscriptionOutcome =
  | { kind: 'success'; transcript: string }
  | { kind: 'empty' }
  | { kind: 'timeout' }
  | { kind: 'failure'; code: 'transcription_aborted' | 'transcription_failed' };

export interface TurnTranscriptionRequest {
  transcribe(signal: AbortSignal): Promise<string>;
  retryNormalized?(this: void, signal: AbortSignal): Promise<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function abortError(): Error {
  const error = new Error('Voice transcription was aborted.');
  error.name = 'AbortError';
  return error;
}

export class TurnTranscriber {
  public constructor(private readonly clock: IClock) {}

  public async transcribe(request: TurnTranscriptionRequest): Promise<TurnTranscriptionOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: TimerHandle | undefined;
    const abortFromCaller = (): void => controller.abort();
    request.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (request.signal?.aborted) controller.abort();
    timeout = this.clock.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS);

    try {
      const transcript = await this.runBounded(() => request.transcribe(controller.signal), controller.signal);
      const normalized = transcript.trim();
      if (normalized) return { kind: 'success', transcript: normalized };
      const retryNormalized = request.retryNormalized;
      if (!retryNormalized) return { kind: 'empty' };
      const retried = await this.runBounded(() => retryNormalized(controller.signal), controller.signal);
      const normalizedRetry = retried.trim();
      return normalizedRetry ? { kind: 'success', transcript: normalizedRetry } : { kind: 'empty' };
    } catch {
      if (timedOut) return { kind: 'timeout' };
      if (controller.signal.aborted) return { kind: 'failure', code: 'transcription_aborted' };
      return { kind: 'failure', code: 'transcription_failed' };
    } finally {
      if (timeout) this.clock.clear(timeout);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private runBounded(operation: () => Promise<string>, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve()
        .then(operation)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
}
