import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findVoiceWorkerUrl, VoiceWorkerClient } from '../src/adapters/process/voiceWorkerClient.ts';
import {
  VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY,
  VOICE_WORKER_PROTOCOL_VERSION,
  VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY,
  VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
} from '../src/services/voiceWorkerProtocol.ts';
import type { VoiceWorkerHandle } from '../src/services/voiceWorkerSupervisor.ts';

type Listener = (value: never) => void;
const directories: string[] = [];

class ClientWorker {
  public readonly posted: unknown[] = [];
  public terminated = false;
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
  public unref(): void {}
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('VoiceWorkerClient', () => {
  it('initializes once, forwards typed commands, and delivers validated events', async () => {
    const worker = new ClientWorker();
    const events: string[] = [];
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => worker as unknown as VoiceWorkerHandle,
      onEvent: (event) => events.push(event.kind),
    });

    const starting = client.start();
    expect(worker.posted[0]).toMatchObject({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: '/private/voice',
      activityHz: 8,
    });
    worker.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture'],
    });
    await starting;
    await expect(client.start()).resolves.toBeUndefined();

    client.beginCapture({
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      mode: 'manual',
      config: {
        engine: 'mlx-whisper',
        language: 'auto',
        recorder: { device: 'none:default' },
        adapters: { 'mlx-whisper': { model: { id: 'local-model' } } },
      },
      maxDurationMs: 300_000,
      utteranceIdleMs: 3_000,
      transcriptionTimeoutMs: 15_000,
    });
    expect(worker.posted[1]).not.toHaveProperty('transcriptionTimeoutMs');
    client.setPlaybackState('session-1', 2, true, {
      text: 'The plan is ready',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
    });
    expect(worker.posted[2]).not.toHaveProperty('referenceText');
    client.confirmBargeIn('session-1', 'capture-1', 'turn-1', 2, 'promote');
    client.finalizeCapture('session-1', 'capture-1', 'explicit-stop');
    client.acknowledgeCandidate('session-1', 'turn-1', 1, 'committed');
    client.cancelCapture('session-1', 'capture-1');

    expect(worker.posted.slice(1).map((message) => (message as { kind: string }).kind)).toEqual([
      'begin-capture',
      'playback-state',
      'finalize-capture',
      'acknowledge-candidate',
      'cancel-capture',
    ]);
    expect(events).toEqual(['ready']);
    await client.shutdown('session-shutdown');
    expect(worker.posted.at(-1)).toMatchObject({ kind: 'shutdown' });
    expect(worker.terminated).toBe(true);
  });

  it('replays active capture and finalization after a supervised worker restart', async () => {
    const initial = new ClientWorker();
    const restarted = new ClientWorker();
    const workers = [initial, restarted];
    let workerIndex = 0;
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => workers[workerIndex++] as unknown as VoiceWorkerHandle,
      onEvent: vi.fn(),
    });
    const starting = client.start();
    initial.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: [
        'capture',
        VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
        VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY,
        VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY,
      ],
    });
    await starting;
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
      transcriptionTimeoutMs: 22_000,
    });
    expect(initial.posted[1]).toMatchObject({ transcriptionTimeoutMs: 22_000 });
    client.setPlaybackState('session-1', 4, true, {
      text: 'A long spoken answer',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
    });
    expect(initial.posted[2]).toMatchObject({
      kind: 'playback-state',
      referenceText: 'A long spoken answer',
      startPhrases: ['hey doom'],
      stopPhrases: ['stop speaking'],
    });
    client.finalizeCapture('session-1', 'capture-1', 'soft-endpoint');
    initial.emit('error', new Error('worker crashed'));
    restarted.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool', VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY],
    });
    expect(restarted.posted.map((message) => (message as { kind: string }).kind)).toEqual([
      'initialize',
      'begin-capture',
      'finalize-capture',
      'playback-state',
    ]);
    expect(restarted.posted[1]).not.toHaveProperty('transcriptionTimeoutMs');
    expect(restarted.posted[3]).toMatchObject({
      referenceText: 'A long spoken answer',
      stopPhrases: ['stop speaking'],
    });
    expect(restarted.posted[3]).not.toHaveProperty('startPhrases');
    client.acknowledgeCandidate('session-1', 'turn-1', 2, 'committed');
    await client.shutdown('session-shutdown');
  });

  it('stops replaying stale capture state after exhausting supervised restarts', async () => {
    const workers: ClientWorker[] = [];
    const exhausted = vi.fn();
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => {
        const worker = new ClientWorker();
        workers.push(worker);
        return worker as unknown as VoiceWorkerHandle;
      },
      onEvent: vi.fn(),
      onExhausted: exhausted,
    });

    const starting = client.start();
    workers[0]!.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    await starting;
    client.beginCapture({
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      mode: 'manual',
      config: {
        engine: 'mlx-whisper',
        language: 'auto',
        recorder: { device: 'none:default' },
        adapters: { 'mlx-whisper': { model: { id: 'local-model' } } },
      },
      maxDurationMs: 300_000,
      utteranceIdleMs: 3_000,
    });

    for (let index = 0; index < 4; index += 1) {
      workers[index]!.emit('error', new Error(`crash ${String(index + 1)}`));
      if (index < 3)
        workers[index + 1]!.emit('message', {
          version: VOICE_WORKER_PROTOCOL_VERSION,
          sequence: 0,
          kind: 'ready',
          capabilities: ['capture', 'durable-spool'],
        });
    }

    expect(workers).toHaveLength(4);
    expect(exhausted).toHaveBeenCalledOnce();
    const restarted = client.start();
    expect(workers).toHaveLength(5);
    expect(workers[4]!.posted).toEqual([expect.objectContaining({ kind: 'initialize' })]);
    workers[4]!.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    await restarted;
    expect(workers[4]!.posted.some((message) => (message as { kind: string }).kind === 'begin-capture')).toBe(false);
    await client.shutdown('session-shutdown');
  });

  it('resumes a frozen revision once and replays a pending acknowledgement without recapture', async () => {
    const workers = [new ClientWorker(), new ClientWorker(), new ClientWorker(), new ClientWorker()];
    let workerIndex = 0;
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => workers[workerIndex++] as unknown as VoiceWorkerHandle,
      onEvent: vi.fn(),
    });
    const starting = client.start();
    workers[0]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    await starting;
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
    });
    client.finalizeCapture('session-1', 'capture-1', 'soft-endpoint');
    workers[0]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 1,
      kind: 'drained',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 1,
    });

    workers[0]?.emit('error', new Error('after drain'));
    workers[1]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    expect(workers[1]?.posted.map((message) => (message as { kind: string }).kind)).toEqual([
      'initialize',
      'begin-capture',
    ]);

    workers[1]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 1,
      kind: 'transcript-candidate',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 1,
      transcript: 'run tests',
      final: true,
    });
    workers[1]?.emit('error', new Error('after candidate'));
    workers[2]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    expect(workers[2]?.posted.map((message) => (message as { kind: string }).kind)).toEqual(['initialize']);

    client.acknowledgeCandidate('session-1', 'turn-1', 1, 'committed');
    workers[2]?.emit('error', new Error('after acknowledgement send'));
    workers[3]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    expect(workers[3]?.posted.map((message) => (message as { kind: string }).kind)).toEqual([
      'initialize',
      'acknowledge-candidate',
    ]);
    expect(workers[3]?.posted[1]).toMatchObject({ revision: 1, outcome: 'committed' });

    workers[3]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 1,
      kind: 'candidate-acknowledged',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 1,
      outcome: 'committed',
    });
    await client.shutdown('session-shutdown');
  });

  it('keeps restart ownership across stale progress and conflicting acknowledgements', async () => {
    const workers = [new ClientWorker(), new ClientWorker(), new ClientWorker()];
    let workerIndex = 0;
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => workers[workerIndex++] as unknown as VoiceWorkerHandle,
      onEvent: vi.fn(),
    });
    const starting = client.start();
    workers[0]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    await starting;
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
    });
    client.setPlaybackState('session-1', 4, true);
    client.setPlaybackState('session-1', 3, false);

    const emitDrained = (sequence: number, sessionId: string, captureId: string, turnId: string, revision: number) =>
      workers[0]?.emit('message', {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence,
        kind: 'drained',
        sessionId,
        captureId,
        turnId,
        revision,
      });
    emitDrained(1, 'stale-session', 'capture-1', 'turn-1', 1);
    emitDrained(2, 'session-1', 'stale-capture', 'turn-1', 1);
    emitDrained(3, 'session-1', 'capture-1', 'stale-turn', 1);
    emitDrained(4, 'session-1', 'capture-1', 'turn-1', 0);
    emitDrained(5, 'session-1', 'capture-1', 'turn-1', 1);
    workers[0]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 6,
      kind: 'failure',
      code: 'transcription_failed',
      recoverable: false,
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 1,
    });

    client.acknowledgeCandidate('session-1', 'turn-1', 1, 'retry');
    client.acknowledgeCandidate('session-1', 'turn-1', 2, 'committed');
    client.acknowledgeCandidate('session-1', 'turn-1', 1, 'committed');
    workers[0]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 7,
      kind: 'candidate-acknowledged',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 1,
      outcome: 'discarded',
    });

    workers[0]?.emit('error', new Error('before acknowledgement confirmation'));
    workers[1]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    expect(workers[1]?.posted).toEqual([
      expect.objectContaining({ kind: 'initialize' }),
      expect.objectContaining({ kind: 'acknowledge-candidate', revision: 1, outcome: 'committed' }),
      expect.objectContaining({ kind: 'playback-state', playbackGeneration: 4, active: true }),
    ]);
    client.setPlaybackState('session-1', 4, false);
    workers[1]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 1,
      kind: 'candidate-acknowledged',
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
      revision: 1,
      outcome: 'committed',
    });

    workers[1]?.emit('error', new Error('after acknowledgement confirmation'));
    workers[2]?.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture', 'durable-spool'],
    });
    expect(workers[2]?.posted.map((message) => (message as { kind: string }).kind)).toEqual(['initialize']);
    await client.shutdown('session-shutdown');
  });
  it('rejects use before start and reports initialization failure', async () => {
    const worker = new ClientWorker();
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => worker as unknown as VoiceWorkerHandle,
      onEvent: vi.fn(),
    });
    expect(() => client.cancelCapture('session-1', 'capture-1')).toThrow('not been started');
    const starting = client.start();
    worker.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'failure',
      code: 'initialization_failed',
      recoverable: false,
    });
    await expect(starting).rejects.toThrow('initialization failed');
    await client.shutdown('extension-dispose');
  });

  it('waits for worker exit after posting graceful shutdown', async () => {
    const worker = new ClientWorker();
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 1_000,
      workerFactory: () => worker as unknown as VoiceWorkerHandle,
      onEvent: vi.fn(),
    });
    const starting = client.start();
    worker.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture'],
    });
    await starting;

    let settled = false;
    const shutdown = client.shutdown('session-shutdown').then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(worker.posted.at(-1)).toMatchObject({ kind: 'shutdown' });
    expect(settled).toBe(false);

    worker.emit('exit', 0);
    await shutdown;
    expect(worker.terminated).toBe(false);
  });
  it('settles pending readiness and starts cleanly after shutdown before ready', async () => {
    const first = new ClientWorker();
    const second = new ClientWorker();
    const workers = [first, second];
    let workerIndex = 0;
    const client = new VoiceWorkerClient({
      spoolDirectory: '/private/voice',
      shutdownTimeoutMs: 0,
      workerFactory: () => workers[workerIndex++] as unknown as VoiceWorkerHandle,
      onEvent: vi.fn(),
    });

    const starting = client.start();
    const startupRejection = expect(starting).rejects.toThrow('startup was cancelled by extension-dispose');
    await client.shutdown('extension-dispose');
    await startupRejection;
    expect(first.terminated).toBe(true);

    const restarting = client.start();
    second.emit('message', {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'ready',
      capabilities: ['capture'],
    });
    await expect(restarting).resolves.toBeUndefined();
    await client.shutdown('session-shutdown');
    expect(second.terminated).toBe(true);
  });

  it('finds the private worker by walking upward from the emitted adapter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-worker-url-'));
    directories.push(root);
    const nested = path.join(root, 'adapters', 'process');
    fs.mkdirSync(nested, { recursive: true });
    const workerPath = path.join(root, 'voiceWorker.mjs');
    fs.writeFileSync(workerPath, '');

    expect(findVoiceWorkerUrl(pathToFileURL(path.join(nested, 'client.mjs'))).href).toBe(
      pathToFileURL(workerPath).href,
    );
    expect(() => findVoiceWorkerUrl(pathToFileURL('/voice-worker-missing/client.mjs'))).toThrow('Cannot find');
  });
});
