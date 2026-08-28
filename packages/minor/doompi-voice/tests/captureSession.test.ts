import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeTurnSpool } from '../src/adapters/process/turnSpool.ts';
import { CaptureSession } from '../src/services/captureSession.ts';
import { PCM_FRAME_BYTES } from '../src/services/pcm.ts';
import type {
  IClock,
  IPcmAudioRecorder,
  LiveRecordingHandle,
  PcmAudioRecorderStartOptions,
  ProcessResult,
  TimerHandle,
} from '../src/types/index.ts';
import type { VoiceMediaCaptureActivity } from '../src/types/clientMedia.ts';

const directories: string[] = [];
const config: ResolvedVoiceConfig = {
  engine: 'whisper-cpp',
  language: 'auto',
  recorder: { device: 'none:default' },
  adapters: { 'whisper-cpp': { model: { path: '/model.bin' } } },
};

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-spool-test-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

class FakeClock implements IClock {
  public nowValue = 0;
  public readonly timeouts: Array<() => void> = [];
  public readonly intervals: Array<() => void> = [];

  public now(): number {
    return this.nowValue;
  }

  public setInterval(callback: () => void): TimerHandle {
    this.intervals.push(callback);
    return { type: 'interval', index: this.intervals.length - 1 } as unknown as TimerHandle;
  }

  public setTimeout(callback: () => void): TimerHandle {
    this.timeouts.push(callback);
    return { type: 'timeout', index: this.timeouts.length - 1 } as unknown as TimerHandle;
  }

  public clear(): void {}
}

class FakeRecording implements LiveRecordingHandle {
  public readonly completion: Promise<ProcessResult>;
  public stopRemainder = Buffer.alloc(0);
  public abortRemainder = Buffer.alloc(0);
  private resolveCompletion!: (result: ProcessResult) => void;

  public constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  public async stop(): Promise<Buffer> {
    this.finish();
    return this.stopRemainder;
  }

  public async abort(): Promise<Buffer> {
    this.finish({ code: 1, stdout: '', stderr: 'aborted' });
    return this.abortRemainder;
  }

  public finish(result: ProcessResult = { code: 0, stdout: '', stderr: '' }): void {
    this.resolveCompletion(result);
  }
}

class FakeRecorder implements IPcmAudioRecorder {
  public readonly handles: FakeRecording[] = [];
  private readonly listeners: Array<(frame: Buffer) => void> = [];
  private readonly activityListeners: Array<((activity: VoiceMediaCaptureActivity) => void) | undefined> = [];

  public preflight(): void {}

  public start(
    _config: ResolvedVoiceConfig,
    onFrame: (frame: Buffer) => void,
    options?: PcmAudioRecorderStartOptions,
  ): LiveRecordingHandle {
    const handle = new FakeRecording();
    this.handles.push(handle);
    this.listeners.push(onFrame);
    this.activityListeners.push(options?.onClientActivity);
    return handle;
  }

  public emit(generation: number, frame: Buffer): void {
    this.listeners[generation - 1]?.(frame);
  }

  public emitActivity(generation: number, activity: VoiceMediaCaptureActivity): void {
    this.activityListeners[generation - 1]?.(activity);
  }
}

function createSpool(): NodeTurnSpool {
  return NodeTurnSpool.create(temporaryRoot(), {
    sessionId: 'session-1',
    captureId: 'capture-1',
    turnId: 'turn-1',
  });
}

describe('NodeTurnSpool', () => {
  it('commits complete PCM, creates private snapshots, and recovers only committed bytes', () => {
    const spool = createSpool();
    const frame = Buffer.alloc(PCM_FRAME_BYTES, 3);
    spool.append(frame);
    fs.appendFileSync(path.join(spool.directory, 'turn.pcm'), Buffer.alloc(8, 9));

    const recovered = NodeTurnSpool.recover(spool.directory);
    expect(recovered.readCommittedPcm()).toEqual(frame);
    expect(fs.statSync(recovered.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(recovered.directory, 'turn.pcm')).mode & 0o777).toBe(0o600);

    const snapshot = recovered.createSnapshot();
    expect(snapshot).toMatchObject({ revision: 1, pcmBytes: PCM_FRAME_BYTES });
    expect(fs.statSync(snapshot.wavPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(snapshot.wavPath).subarray(44)).toEqual(frame);
    recovered.acknowledge(1, 'committed');
    expect(recovered.snapshotManifest()).toMatchObject({ acknowledgedRevision: 1, acknowledgedOutcome: 'committed' });
  });

  it('persists a write-once utterance boundary and snapshots only its committed suffix', () => {
    const spool = createSpool();
    const leadingIdle = Buffer.alloc(PCM_FRAME_BYTES, 1);
    const utterance = Buffer.alloc(PCM_FRAME_BYTES, 2);
    spool.append(leadingIdle);
    spool.append(utterance);
    spool.markUtteranceStart(PCM_FRAME_BYTES);
    spool.markUtteranceStart(PCM_FRAME_BYTES);
    expect(() => spool.markUtteranceStart(0)).toThrow('already set');
    spool.close();

    const recovered = NodeTurnSpool.recover(spool.directory);
    expect(recovered.snapshotManifest()).toMatchObject({
      committedBytes: PCM_FRAME_BYTES * 2,
      utteranceStartByte: PCM_FRAME_BYTES,
    });
    const snapshot = recovered.createSnapshot();
    expect(snapshot.pcmBytes).toBe(PCM_FRAME_BYTES);
    expect(fs.readFileSync(snapshot.wavPath).subarray(44)).toEqual(utterance);
  });

  it('rejects incomplete samples, invalid generations, and stale acknowledgements', () => {
    const spool = createSpool();
    expect(() => spool.append(Buffer.alloc(3))).toThrow('complete 16-bit samples');
    spool.append(Buffer.alloc(0));
    spool.setCaptureGeneration(2);
    expect(() => spool.setCaptureGeneration(1)).toThrow('monotonic');
    expect(() => spool.acknowledge(1, 'committed')).toThrow('revision');
    const first = spool.createSnapshot();
    const second = spool.createSnapshot();
    spool.acknowledge(second.revision, 'committed');
    expect(() => spool.acknowledge(first.revision, 'discarded')).toThrow('monotonic');
    spool.close();
    expect(() => spool.readCommittedPcm()).toThrow('closed');
  });

  it.each([
    { field: 'version', value: 2, message: 'version' },
    { field: 'sessionId', value: '../escape', message: 'sessionId' },
    { field: 'committedBytes', value: 3, message: 'complete samples' },
    { field: 'utteranceStartByte', value: 3, message: 'complete samples' },
    { field: 'utteranceStartByte', value: 2, message: 'exceeds committed length' },
    { field: 'captureGeneration', value: -1, message: 'non-negative integer' },
    { field: 'acknowledgedOutcome', value: 'retry', message: 'outcome' },
  ])('rejects a corrupt manifest field $field', ({ field, value, message }) => {
    const spool = createSpool();
    const manifestPath = path.join(spool.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest[field] = value;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => NodeTurnSpool.recover(spool.directory)).toThrow(message);
  });

  it('rejects a spool shorter than its committed manifest length and removes acknowledged data', () => {
    const spool = createSpool();
    spool.append(Buffer.alloc(20));
    fs.truncateSync(path.join(spool.directory, 'turn.pcm'), 10);
    expect(() => NodeTurnSpool.recover(spool.directory)).toThrow('shorter');

    const removable = createSpool();
    const directory = removable.directory;
    removable.remove();
    expect(fs.existsSync(directory)).toBe(false);
  });
});

describe('CaptureSession', () => {
  it('rejects duplicate starts and inactive drains', async () => {
    const recorder = new FakeRecorder();
    const spool = createSpool();
    const session = new CaptureSession({ recorder, config, spool, clock: new FakeClock() });

    await expect(session.drain()).rejects.toThrow('not active');
    const starting = session.start();
    await expect(session.start()).rejects.toThrow('already started');
    recorder.emit(1, Buffer.alloc(PCM_FRAME_BYTES));
    await starting;
    await session.abort();
  });

  it('starts liveness only after the first frame and drains the final remainder', async () => {
    const recorder = new FakeRecorder();
    const clock = new FakeClock();
    const spool = createSpool();
    const session = new CaptureSession({ recorder, config, spool, clock });

    const starting = session.start();
    expect(session.state).toBe('starting');
    expect(clock.intervals).toHaveLength(0);
    recorder.emit(1, Buffer.alloc(PCM_FRAME_BYTES, 1));
    await starting;
    expect(session.state).toBe('capturing');
    expect(clock.intervals).toHaveLength(1);

    recorder.handles[0]!.stopRemainder = Buffer.alloc(22, 2);
    const snapshot = await session.drain();
    expect(snapshot.pcmBytes).toBe(PCM_FRAME_BYTES + 22);
    expect(spool.readCommittedPcm()).toEqual(Buffer.concat([Buffer.alloc(PCM_FRAME_BYTES, 1), Buffer.alloc(22, 2)]));
  });

  it('recovers a first-frame timeout before starting liveness', async () => {
    const recorder = new FakeRecorder();
    const clock = new FakeClock();
    const spool = createSpool();
    const session = new CaptureSession({ recorder, config, spool, clock, maxRecoveryAttempts: 1 });

    const starting = session.start();
    clock.timeouts[0]!();
    await vi.waitFor(() => expect(spool.snapshotManifest().captureGeneration).toBe(2));
    recorder.emit(2, Buffer.alloc(PCM_FRAME_BYTES, 8));
    await starting;

    expect(session.state).toBe('capturing');
    expect(spool.snapshotManifest().gapCount).toBe(1);
    await session.abort();
    await session.abort();
  });

  it('reports an incomplete trailing sample after preserving all complete bytes', async () => {
    const recorder = new FakeRecorder();
    const spool = createSpool();
    const session = new CaptureSession({ recorder, config, spool, clock: new FakeClock() });
    const starting = session.start();
    recorder.emit(1, Buffer.alloc(PCM_FRAME_BYTES, 1));
    await starting;
    recorder.handles[0]!.stopRemainder = Buffer.from([2, 3, 4]);

    await expect(session.drain()).rejects.toThrow('incomplete trailing PCM sample');
    expect(spool.readCommittedPcm()).toEqual(Buffer.concat([Buffer.alloc(PCM_FRAME_BYTES, 1), Buffer.from([2, 3])]));
  });

  it('preserves the failed recorder remainder and open turn across recovery', async () => {
    const recorder = new FakeRecorder();
    const clock = new FakeClock();
    const spool = createSpool();
    const gaps = vi.fn();
    const session = new CaptureSession({ recorder, config, spool, clock, onGap: gaps });

    const starting = session.start();
    recorder.emit(1, Buffer.alloc(PCM_FRAME_BYTES, 4));
    await starting;
    recorder.handles[0]!.abortRemainder = Buffer.alloc(10, 5);
    recorder.handles[0]!.finish({ code: 1, stdout: '', stderr: 'device reset' });
    await vi.waitFor(() => expect(spool.snapshotManifest().captureGeneration).toBe(2));
    recorder.emit(2, Buffer.alloc(PCM_FRAME_BYTES, 6));
    await vi.waitFor(() => expect(session.state).toBe('capturing'));

    expect(spool.snapshotManifest()).toMatchObject({ captureGeneration: 2, gapCount: 1 });
    expect(gaps).toHaveBeenCalledWith(1);
    recorder.handles[1]!.stopRemainder = Buffer.alloc(12, 7);
    const snapshot = await session.drain();
    expect(snapshot.pcmBytes).toBe(PCM_FRAME_BYTES * 2 + 22);
    expect(spool.readCommittedPcm()).toEqual(
      Buffer.concat([
        Buffer.alloc(PCM_FRAME_BYTES, 4),
        Buffer.alloc(10, 5),
        Buffer.alloc(PCM_FRAME_BYTES, 6),
        Buffer.alloc(12, 7),
      ]),
    );
  });

  it('scopes client activity to the active recovery generation', async () => {
    const recorder = new FakeRecorder();
    const spool = createSpool();
    const activities: Array<{ activity: VoiceMediaCaptureActivity; generation: number }> = [];
    const session = new CaptureSession({
      recorder,
      config,
      spool,
      clock: new FakeClock(),
      onClientActivity: (activity, generation) => activities.push({ activity, generation }),
    });

    const starting = session.start();
    recorder.emit(1, Buffer.alloc(PCM_FRAME_BYTES));
    await starting;
    recorder.emitActivity(1, { state: 'speech', levelDbfs: -35, elapsedMs: 500 });
    recorder.handles[0]!.finish({ code: 1, stdout: '', stderr: 'upload interrupted' });
    await vi.waitFor(() => expect(spool.snapshotManifest().captureGeneration).toBe(2));
    recorder.emit(2, Buffer.alloc(PCM_FRAME_BYTES));
    await vi.waitFor(() => expect(session.state).toBe('capturing'));

    recorder.emitActivity(1, { state: 'endpoint', levelDbfs: -80, elapsedMs: 1_100 });
    recorder.emitActivity(2, { state: 'listening', levelDbfs: -70, elapsedMs: 100 });

    expect(activities).toEqual([
      { activity: { state: 'speech', levelDbfs: -35, elapsedMs: 500 }, generation: 1 },
      { activity: { state: 'listening', levelDbfs: -70, elapsedMs: 100 }, generation: 2 },
    ]);
    expect(spool.snapshotManifest()).toMatchObject({ captureGeneration: 2, gapCount: 1 });
    await session.abort();
  });
});
