import { describe, expect, it, vi } from 'vitest';
import { startVoiceWorker, type VoiceWorkerRuntimeHandle } from '../src/adapters/process/voiceWorker.ts';
import { VoiceWorkerClient } from '../src/adapters/process/voiceWorkerClient.ts';
import type { VoiceWorkerHandle } from '../src/services/voiceWorkerSupervisor.ts';
import {
  type VoiceWorkerCommand,
  type VoiceWorkerEvent,
  VOICE_WORKER_PROTOCOL_VERSION,
  VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
} from '../src/services/voiceWorkerProtocol.ts';

class WorkerBridge implements VoiceWorkerHandle {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();
  private commandListener: ((value: unknown) => void) | undefined;
  private runtime: VoiceWorkerRuntimeHandle | undefined;

  public readonly port = {
    on: (_event: 'message', listener: (value: unknown) => void) => {
      this.commandListener = listener;
      return this.port;
    },
    off: (_event: 'message', listener: (value: unknown) => void) => {
      if (this.commandListener === listener) this.commandListener = undefined;
      return this.port;
    },
    postMessage: (value: VoiceWorkerEvent) => this.emit('message', value),
    close: vi.fn(),
  };

  public attach(runtime: VoiceWorkerRuntimeHandle): void {
    this.runtime = runtime;
  }

  public postMessage(value: unknown): void {
    this.commandListener?.(value);
  }

  public on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (value: unknown) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  public async terminate(): Promise<number> {
    await this.runtime?.dispose();
    return 0;
  }

  public unref(): void {}

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('voice worker host boundary', () => {
  it('negotiates and parses the configurable transcription timeout end to end', async () => {
    const bridge = new WorkerBridge();
    const handled: VoiceWorkerCommand[] = [];
    const hooks = {
      initialize: vi.fn(),
      capabilities: () => ['capture', VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY],
      handle: vi.fn((command: Exclude<VoiceWorkerCommand, { kind: 'initialize' | 'shutdown' }>) => {
        handled.push(command);
      }),
      shutdown: vi.fn(),
    };
    bridge.attach(startVoiceWorker(bridge.port, hooks));
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      workerFactory: () => bridge,
      onEvent: vi.fn(),
    });

    await client.start();
    client.beginCapture({
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      mode: 'autonomous',
      config: {
        engine: 'mlx-whisper',
        language: 'auto',
        recorder: { device: 'none:default' },
        adapters: { 'mlx-whisper': { model: { id: 'local-model' } } },
      },
      maxDurationMs: 300_000,
      utteranceIdleMs: 3_000,
      transcriptionTimeoutMs: 21_000,
    });
    await flush();

    expect(handled).toContainEqual(expect.objectContaining({ kind: 'begin-capture', transcriptionTimeoutMs: 21_000 }));
    await client.shutdown('session-shutdown');
    expect(hooks.shutdown).toHaveBeenCalledWith('session-shutdown');
  });

  it('returns a bounded diagnostic for a malformed control field', async () => {
    const bridge = new WorkerBridge();
    const events: VoiceWorkerEvent[] = [];
    bridge.on('message', (event) => events.push(event));
    bridge.attach(
      startVoiceWorker(bridge.port, {
        handle: vi.fn(),
        shutdown: vi.fn(),
      }),
    );

    bridge.postMessage({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: '/private/voice',
      activityHz: 8,
      transcriptionTimeoutMs: 15_000,
    });
    await flush();

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'failure',
        code: 'invalid_control_message_transcriptiontimeoutms',
        recoverable: true,
      }),
    );
  });
});
