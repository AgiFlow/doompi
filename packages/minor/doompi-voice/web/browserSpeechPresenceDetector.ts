import type { SpeechPresenceDetector, SpeechPresenceWindow } from '../src/types/clientCaptureActivity.ts';

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

function isWorkerReply(value: unknown): value is WorkerReply {
  return typeof value === 'object' && value !== null && Number.isSafeInteger((value as { id?: unknown }).id);
}

export class BrowserSpeechPresenceDetector implements SpeechPresenceDetector {
  private nextRequestId = 0;
  private generation = 0;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private failure: Error | undefined;

  public constructor(
    private readonly worker: SpeechWorker,
    private readonly onTerminalFailure: () => void = () => undefined,
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
    const result = await this.enqueue(() => this.request({ type: 'push', pcm: owned.buffer }, [owned.buffer]));
    if (generation !== this.generation) return [];
    if (!Array.isArray(result)) throw new Error('Silero worker returned invalid speech windows.');
    return result as SpeechPresenceWindow[];
  }

  public async reset(): Promise<void> {
    this.generation += 1;
    await this.enqueue(() => this.request({ type: 'reset' }));
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

  private request(message: Record<string, unknown>, transfer?: ArrayBuffer[]): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('Silero worker is closed.'));
    const id = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
