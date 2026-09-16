import type { SpeechPresenceDetector, SpeechPresenceWindow } from '../../../../../../types/clientCaptureActivity';

export interface SpeechWorker {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
}

interface WorkerReply {
  id: number;
  result?: unknown;
  error?: string;
}

interface PendingWorkerRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

const WORKER_RESPONSE_TIMEOUT_MS = 5_000;

class WorkerResponseTimeoutError extends Error {}

function isWorkerReply(value: unknown): value is WorkerReply {
  return typeof value === 'object' && value !== null && Number.isSafeInteger((value as { id?: unknown }).id);
}

export class BrowserSpeechPresenceDetector implements SpeechPresenceDetector {
  private nextRequestId = 0;
  private generation = 0;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, PendingWorkerRequest>();
  private closed = false;
  private failure: Error | undefined;

  public constructor(
    private readonly worker: SpeechWorker,
    private readonly onTerminalFailure: () => void = () => undefined,
    private readonly responseTimeoutMs = WORKER_RESPONSE_TIMEOUT_MS,
  ) {
    worker.onmessage = (event) => {
      if (!isWorkerReply(event.data)) {
        this.failTerminal(new Error('Silero worker returned a malformed response.'));
        return;
      }
      const pending = this.pending.get(event.data.id);
      if (pending === undefined) return;
      if (event.data.error !== undefined) this.failTerminal(new Error(event.data.error));
      else {
        this.pending.delete(event.data.id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.resolve(event.data.result);
      }
    };
    worker.onerror = (event) => this.failTerminal(new Error(event.message || 'Silero worker failed.'));
  }

  public async initialize(modelUrl: string): Promise<void> {
    const result = await this.enqueue(() => this.request({ type: 'initialize', modelUrl }));
    if (result !== true) {
      const error = new Error('Silero worker returned an invalid initialization response.');
      this.failTerminal(error);
      throw error;
    }
  }

  public async push(pcm: Uint8Array): Promise<readonly SpeechPresenceWindow[]> {
    const generation = this.generation;
    const owned = new Uint8Array(pcm);
    let result: unknown;
    try {
      result = await this.enqueue(() =>
        this.request({ type: 'push', pcm: owned.buffer }, [owned.buffer], this.responseTimeoutMs),
      );
    } catch (error) {
      if (error instanceof WorkerResponseTimeoutError) return [];
      throw error;
    }
    if (generation !== this.generation) return [];
    if (!Array.isArray(result)) throw new Error('Silero worker returned invalid speech windows.');
    return result as SpeechPresenceWindow[];
  }

  public async reset(): Promise<void> {
    this.generation += 1;
    await this.enqueue(() => this.request({ type: 'reset' }, undefined, this.responseTimeoutMs));
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.failAll(new Error('Silero worker closed.'));
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const queued = this.operation.then(run, run);
    this.operation = queued;
    return queued;
  }

  private request(message: Record<string, unknown>, transfer?: ArrayBuffer[], timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('Silero worker is closed.'));
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const pending: PendingWorkerRequest = { resolve, reject };
      if (timeoutMs !== undefined)
        pending.timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.failTerminal(new WorkerResponseTimeoutError('Silero worker response timed out.'));
        }, timeoutMs);
      this.pending.set(id, pending);
      this.worker.postMessage({ id, ...message }, transfer);
    });
  }

  private failTerminal(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.generation += 1;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.failAll(error);
    this.onTerminalFailure();
  }
  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
