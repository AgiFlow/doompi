import type { AsrDecodingEvidence, IClock, TimerHandle, TranscriptionAdapterOutput } from '../types/index.ts';

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 15_000;

export type TurnTranscriptionOutcome =
  | { kind: 'success'; transcript: string; evidence?: AsrDecodingEvidence }
  | { kind: 'empty'; evidence?: AsrDecodingEvidence }
  | { kind: 'timeout' }
  | { kind: 'failure'; code: 'transcription_aborted' | 'transcription_failed' };

export interface TurnTranscriptionRequest {
  transcribe(signal: AbortSignal): Promise<TranscriptionAdapterOutput>;
  retryNormalized?(this: void, signal: AbortSignal): Promise<TranscriptionAdapterOutput>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function abortError(): Error {
  const error = new Error('Voice transcription was aborted.');
  error.name = 'AbortError';
  return error;
}

function normalizedOutput(output: TranscriptionAdapterOutput): { transcript: string; evidence?: AsrDecodingEvidence } {
  if (typeof output === 'string') return { transcript: output.trim() };
  const transcript = output.transcript.trim();
  return { transcript, ...(output.evidence ? { evidence: output.evidence } : {}) };
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
      const first = normalizedOutput(
        await this.runBounded(() => request.transcribe(controller.signal), controller.signal),
      );
      if (first.transcript)
        return {
          kind: 'success',
          transcript: first.transcript,
          ...(first.evidence ? { evidence: first.evidence } : {}),
        };
      const retryNormalized = request.retryNormalized;
      if (!retryNormalized) return { kind: 'empty', ...(first.evidence ? { evidence: first.evidence } : {}) };
      const retried = normalizedOutput(
        await this.runBounded(() => retryNormalized(controller.signal), controller.signal),
      );
      if (retried.transcript)
        return {
          kind: 'success',
          transcript: retried.transcript,
          ...(retried.evidence ? { evidence: retried.evidence } : {}),
        };
      const evidence = retried.evidence ?? first.evidence;
      return { kind: 'empty', ...(evidence ? { evidence } : {}) };
    } catch {
      if (timedOut) return { kind: 'timeout' };
      if (controller.signal.aborted) return { kind: 'failure', code: 'transcription_aborted' };
      return { kind: 'failure', code: 'transcription_failed' };
    } finally {
      if (timeout) this.clock.clear(timeout);
      request.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private runBounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      void Promise.resolve()
        .then(operation)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
}
