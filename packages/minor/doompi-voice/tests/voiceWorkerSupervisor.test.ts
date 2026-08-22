import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceWorkerHandle } from '../src/services/voiceWorkerSupervisor.ts';
import { VoiceWorkerSupervisor } from '../src/services/voiceWorkerSupervisor.ts';
import { VOICE_WORKER_PROTOCOL_VERSION } from '../src/services/voiceWorkerProtocol.ts';

type Listener = (value: never) => void;

class FakeWorker {
  public readonly posted: unknown[] = [];
  public terminated = false;
  public unreferenced = false;
  private readonly listeners = new Map<string, Listener[]>();

  public postMessage(value: unknown): void {
    this.posted.push(value);
  }

  public on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  public emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }

  public async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  public unref(): void {
    this.unreferenced = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceWorkerSupervisor', () => {
  it('validates events and restarts a failed worker', async () => {
    const workers: FakeWorker[] = [];
    const events: string[] = [];
    const restarted: string[] = [];
    const supervisor = new VoiceWorkerSupervisor({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as VoiceWorkerHandle;
      },
      onEvent: (event) => events.push(event.kind),
      onRestart: (reason) => restarted.push(reason),
    });

    supervisor.start();
    workers[0]!.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: [],
    });
    workers[0]!.emit('error', new Error('crashed'));

    expect(events).toEqual(['ready']);
    expect(restarted).toEqual(['error']);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.unreferenced).toBe(true);
    await supervisor.stop();
  });

  it('restarts after a missed heartbeat', async () => {
    vi.useFakeTimers();
    let now = 0;
    const workers: FakeWorker[] = [];
    const supervisor = new VoiceWorkerSupervisor({
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as VoiceWorkerHandle;
      },
      onEvent: () => undefined,
      now: () => now,
      heartbeatTimeoutMs: 100,
      heartbeatCheckMs: 50,
    });

    supervisor.start();
    now = 101;
    await vi.advanceTimersByTimeAsync(50);

    expect(workers).toHaveLength(2);
    await supervisor.stop();
  });
});
