import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientPcmAudioRecorder } from '../src/adapters/audio/clientMedia.ts';
import { createVoiceMediaApi } from '../src/adapters/clientMediaApi.ts';
import { NodeTurnSpool } from '../src/adapters/process/turnSpool.ts';
import { VoiceWorkerPipeline } from '../src/adapters/process/voiceWorkerPipeline.ts';
import { PCM_FRAME_BYTES, PCM_FRAME_MS } from '../src/services/pcm.ts';
import {
  VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY,
  VOICE_WORKER_PROTOCOL_VERSION,
  VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY,
  VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
  type VoiceWorkerEventPayload,
} from '../src/services/voiceWorkerProtocol.ts';
import type {
  IClock,
  IPcmAudioRecorder,
  ISpeechPresenceDetector,
  ITranscriberAdapter,
  ITranscriberRegistry,
  IVoiceMediaHostConnection,
  LiveRecordingHandle,
  PcmAudioRecorderStartOptions,
  ProcessResult,
  TimerHandle,
  TranscriptionRequest,
  VoiceMediaAudioPoll,
} from '../src/types/index.ts';
import {
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  VOICE_MEDIA_CONTENT_TYPE,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
  type VoiceMediaCaptureActivity,
} from '../src/types/clientMedia.ts';

const directories: string[] = [];
const AMBIENT_REBASE_EXERCISE_MS = 1_600;
const config: ResolvedVoiceConfig = {
  engine: 'mlx-whisper',
  language: 'auto',
  recorder: { device: 'none:default' },
  adapters: { 'mlx-whisper': { model: { id: 'local-model' } } },
};

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-worker-test-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

class WorkerClock implements IClock {
  private currentTime = 0;
  public now(): number {
    return this.currentTime;
  }
  public advance(milliseconds: number): void {
    this.currentTime += milliseconds;
  }
  public setInterval(): TimerHandle {
    return { kind: 'interval' } as unknown as TimerHandle;
  }
  public setTimeout(): TimerHandle {
    return { kind: 'timeout' } as unknown as TimerHandle;
  }
  public clear(): void {}
}

class ScheduledWorkerClock implements IClock {
  private currentTime = 0;
  private readonly timers = new Map<TimerHandle, { due: number; callback: () => void }>();
  public now(): number {
    return this.currentTime;
  }
  public setInterval(callback: () => void, milliseconds: number): TimerHandle {
    return this.schedule(callback, milliseconds);
  }
  public setTimeout(callback: () => void, milliseconds: number): TimerHandle {
    return this.schedule(callback, milliseconds);
  }
  public clear(handle: TimerHandle): void {
    this.timers.delete(handle);
  }
  public advance(milliseconds: number): void {
    this.currentTime += milliseconds;
    for (const [handle, timer] of this.timers) {
      if (timer.due > this.currentTime) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }
  private schedule(callback: () => void, milliseconds: number): TimerHandle {
    const handle = { id: Symbol('timer') } as unknown as TimerHandle;
    this.timers.set(handle, { due: this.currentTime + milliseconds, callback });
    return handle;
  }
}

class WorkerRecording implements LiveRecordingHandle {
  public readonly completion: Promise<ProcessResult>;
  public remainder = Buffer.alloc(0);
  private resolveCompletion!: (result: ProcessResult) => void;

  public constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }
  public async stop(): Promise<Buffer> {
    this.resolveCompletion({ code: 0, stdout: '', stderr: '' });
    return this.remainder;
  }
  public async abort(): Promise<Buffer> {
    this.resolveCompletion({ code: 1, stdout: '', stderr: 'aborted' });
    return Buffer.alloc(0);
  }
}

class WorkerRecorder implements IPcmAudioRecorder {
  public readonly handle = new WorkerRecording();
  private listener: ((frame: Buffer) => void) | undefined;
  private activityListener: ((activity: VoiceMediaCaptureActivity) => void) | undefined;

  public preflight(): void {}
  public start(
    _config: ResolvedVoiceConfig,
    onFrame: (frame: Buffer) => void,
    options?: PcmAudioRecorderStartOptions,
  ): LiveRecordingHandle {
    this.listener = onFrame;
    this.activityListener = options?.onClientActivity;
    return this.handle;
  }
  public get ready(): boolean {
    return this.listener !== undefined;
  }
  public emit(frame: Buffer): void {
    this.listener?.(frame);
  }
  public emitActivity(activity: VoiceMediaCaptureActivity): void {
    this.activityListener?.(activity);
  }
}

function beginCommand() {
  return {
    version: VOICE_WORKER_PROTOCOL_VERSION,
    sequence: 1,
    kind: 'begin-capture',
    sessionId: 'session-1',
    captureId: 'capture-1',
    turnId: 'turn-1',
    mode: 'manual',
    config,
    maxDurationMs: 300_000,
    utteranceIdleMs: 3_000,
  } as const;
}

function pcmFrame(sample: number): Buffer {
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  for (let offset = 0; offset < frame.length; offset += 2) frame.writeInt16LE(sample, offset);
  return frame;
}

function registryWith(adapter: ITranscriberAdapter): ITranscriberRegistry {
  return { select: () => ({ adapter, config: config.adapters['mlx-whisper']! }) };
}

function speechDetectorFactory(): ISpeechPresenceDetector {
  return {
    push: () => true,
    reset: () => undefined,
  };
}

describe('VoiceWorkerPipeline manual dictation', () => {
  it('transcribes one immutable full-session snapshot and retains it until acknowledgement', async () => {
    const recorder = new WorkerRecorder();
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => 'one two three four');
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith(adapter),
    });
    const events: VoiceWorkerEventPayload[] = [];
    const publish = (event: VoiceWorkerEventPayload) => events.push(event);
    const root = temporaryRoot();
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });

    const beginning = pipeline.handle(beginCommand(), publish);
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(Buffer.alloc(PCM_FRAME_BYTES, 2));
    await beginning;
    recorder.handle.remainder = Buffer.alloc(24, 3);
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'explicit-stop',
      },
      publish,
    );

    expect(transcribe).toHaveBeenCalledTimes(1);
    const request = transcribe.mock.calls[0]![0] as TranscriptionRequest;
    expect(fs.readFileSync(request.audioPath).subarray(44)).toEqual(
      Buffer.concat([Buffer.alloc(PCM_FRAME_BYTES, 2), Buffer.alloc(24, 3)]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'transcript-candidate',
        transcript: 'one two three four',
        turnId: 'turn-1',
        revision: 1,
      }),
    );
    expect(fs.readdirSync(root)).toHaveLength(1);

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'acknowledge-candidate',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 1,
        outcome: 'committed',
      },
      publish,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'candidate-acknowledged',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        revision: 1,
        outcome: 'committed',
      }),
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reports digital silence without retry and cancels only matching active captures', async () => {
    const recorder = new WorkerRecorder();
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => '');
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith(adapter),
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });
    const beginning = pipeline.handle(beginCommand(), (event) => events.push(event));
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(Buffer.alloc(PCM_FRAME_BYTES));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 1,
        active: true,
      },
      (event) => events.push(event),
    );
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'cancel-capture',
        sessionId: 'other-session',
        captureId: 'capture-1',
      },
      (event) => events.push(event),
    );
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 4,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'explicit-stop',
      },
      (event) => events.push(event),
    );

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'failure', code: 'empty_transcript' }));
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 5,
        kind: 'acknowledge-candidate',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 1,
        outcome: 'discarded',
      },
      (event) => events.push(event),
    );
    await pipeline.shutdown();
  });

  it('retries one nonzero empty result with bounded gain normalization', async () => {
    const recorder = new WorkerRecorder();
    const responses = ['', 'quiet words'];
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => responses.shift() ?? '');
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith(adapter),
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });
    const beginning = pipeline.handle(beginCommand(), (event) => events.push(event));
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    const quiet = Buffer.alloc(PCM_FRAME_BYTES);
    quiet.writeInt16LE(25, 0);
    recorder.emit(quiet);
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'explicit-stop',
      },
      (event) => events.push(event),
    );

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect((transcribe.mock.calls[1]![0] as TranscriptionRequest).audioPath).toContain('normalized-1.wav');
    expect(events).toContainEqual(expect.objectContaining({ kind: 'transcript-candidate', transcript: 'quiet words' }));
    await pipeline.shutdown();
  });

  it('aborts and reports a hung final ASR at the configured deadline', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    let observedSignal: AbortSignal | undefined;
    const transcribe = vi.fn((request: TranscriptionRequest) => {
      observedSignal = request.signal;
      return new Promise<string>(() => undefined);
    });
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({ clock, recorder, registry: registryWith(adapter) });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), transcriptionTimeoutMs: 15_000 }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(1_000));
    await beginning;
    const finalization = pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'explicit-stop',
      },
      (published) => events.push(published),
    );
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());

    clock.advance(15_000);
    await finalization;

    expect(observedSignal?.aborted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'failure', code: 'transcription_timed_out', recoverable: false }),
    );
    await pipeline.shutdown();
  });

  it('reports the autonomous capture duration as a recoverable lifecycle boundary', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const transcribe = vi.fn(async () => 'unused');
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle(
      { ...beginCommand(), mode: 'autonomous' as const, maxDurationMs: 100 },
      (published) => events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;

    clock.advance(100);

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'failure', code: 'capture_duration_limit', recoverable: true }),
    );
    expect(transcribe).not.toHaveBeenCalled();
    await pipeline.shutdown();
  });

  it('requires neural speech evidence before autonomous capture confirms high energy', async () => {
    const recorder = new WorkerRecorder();
    const speechDetector: ISpeechPresenceDetector = {
      push: vi.fn(() => false),
      reset: vi.fn(),
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith({
        engine: 'mlx-whisper',
        preflight: () => undefined,
        transcribe: vi.fn(async () => 'unused'),
      }),
      speechDetectorFactory: () => speechDetector,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });

    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    for (let index = 0; index < 10; index += 1) recorder.emit(pcmFrame(8_000));
    await beginning;

    expect(speechDetector.push).toHaveBeenCalledTimes(10);
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    await pipeline.shutdown();
  });

  it('uses client-owned speech and endpoint decisions without host neural approval', async () => {
    const recorder = new WorkerRecorder();
    const speechDetector: ISpeechPresenceDetector = {
      push: vi.fn(() => false),
      reset: vi.fn(),
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith({
        engine: 'mlx-whisper',
        preflight: () => undefined,
        transcribe: vi.fn(async () => 'unused'),
      }),
      speechDetectorFactory: () => speechDetector,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });

    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emitActivity({ state: 'listening', levelDbfs: -72, elapsedMs: 100 });
    recorder.emit(pcmFrame(100));
    recorder.emitActivity({ state: 'speech', levelDbfs: -42, elapsedMs: 200 });
    recorder.emit(pcmFrame(2_000));
    recorder.emitActivity({ state: 'endpoint', levelDbfs: -70, elapsedMs: 3_200 });
    await beginning;

    expect(speechDetector.push).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'endpoint-reached', turnId: 'turn-1' }));
    await pipeline.shutdown();
  });

  it('delivers queued API speech and endpoint transitions through the recorder to one endpoint', async () => {
    const internalToken = 'pipeline-media-token';
    const clientId = 'pipeline-client';
    const connectionId = 'pipeline-connection';
    const api = createVoiceMediaApi({ internalToken });
    const apiRequest = (route: string, init: RequestInit = {}, host = false): Request => {
      const headers = new Headers(init.headers);
      if (host) headers.set('authorization', `Bearer ${internalToken}`);
      return new Request(`http://voice.test${route}`, { ...init, headers });
    };
    const postJson = (value: object): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    expect(
      (
        await api.fetch(
          apiRequest(
            VOICE_MEDIA_ROUTES.clientConnect,
            postJson({
              version: VOICE_MEDIA_PROTOCOL_VERSION,
              clientId,
              connectionId,
              clientKind: 'browser',
              controlLocation: 'local',
              capabilities: { capture: true, playback: false, captureActivity: true, autonomousOrchestration: true },
            }),
          ),
        )
      ).status,
    ).toBe(200);

    let captureId: string | undefined;
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const connection: IVoiceMediaHostConnection = {
      startCapture: async (nextCaptureId, configuration) => {
        captureId = nextCaptureId;
        const response = await api.fetch(
          apiRequest(VOICE_MEDIA_ROUTES.hostCaptureStart, postJson({ captureId: nextCaptureId, configuration }), true),
        );
        if (response.status !== 201) throw new Error('capture start failed');
      },
      readCapture: async (activeCaptureId): Promise<VoiceMediaAudioPoll> => {
        await readsReleased;
        const response = await api.fetch(
          apiRequest(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=${activeCaptureId}`, {}, true),
        );
        if (response.status === 204) return { pcm: Buffer.alloc(0), state: 'stopped' };
        if (response.status !== 200) throw new Error('capture read failed');
        const state = response.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER);
        const activity: VoiceMediaCaptureActivity | undefined =
          state === 'listening' || state === 'speech' || state === 'endpoint'
            ? {
                state,
                levelDbfs: Number(response.headers.get(VOICE_MEDIA_ACTIVITY_LEVEL_HEADER)),
                elapsedMs: Number(response.headers.get(VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER)),
              }
            : undefined;
        return {
          pcm: Buffer.from(await response.arrayBuffer()),
          state: 'active',
          ...(activity === undefined ? {} : { activity }),
        };
      },
      stopCapture: async (activeCaptureId) => {
        await api.fetch(apiRequest(VOICE_MEDIA_ROUTES.hostCaptureStop, postJson({ captureId: activeCaptureId }), true));
      },
      abortCapture: async (activeCaptureId) => {
        await api.fetch(
          apiRequest(VOICE_MEDIA_ROUTES.hostCaptureAbort, postJson({ captureId: activeCaptureId }), true),
        );
      },
      startPlayback: async () => undefined,
      readPlayback: async () => undefined,
      stopPlayback: async () => undefined,
      abortPlayback: async () => undefined,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder: new ClientPcmAudioRecorder(connection),
      registry: registryWith({
        engine: 'mlx-whisper',
        preflight: () => undefined,
        transcribe: vi.fn(async () => 'unused'),
      }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (event) =>
      events.push(event),
    );
    await vi.waitFor(() => expect(captureId).toBeDefined());
    const audioRoute = `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${clientId}&connectionId=${connectionId}&captureId=${captureId!}`;
    const upload = (state: 'speech' | 'endpoint', elapsedMs: number, pcm: Buffer): Promise<Response> =>
      Promise.resolve(
        api.fetch(
          apiRequest(audioRoute, {
            method: 'POST',
            headers: {
              'content-type': VOICE_MEDIA_CONTENT_TYPE,
              [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: state,
              [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: state === 'speech' ? '-35' : '-80',
              [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: String(elapsedMs),
            },
            body: pcm,
          }),
        ),
      );
    expect((await upload('speech', 500, pcmFrame(2_000))).status).toBe(204);
    expect((await upload('endpoint', 1_100, pcmFrame(0))).status).toBe(204);
    releaseReads();
    await beginning;
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'endpoint-reached')).toHaveLength(1));

    expect(
      events.flatMap((event) =>
        event.kind === 'activity' && (event.elapsedMs === 500 || event.elapsedMs === 1_100)
          ? [{ state: event.state, elapsedMs: event.elapsedMs }]
          : [],
      ),
    ).toEqual([
      { state: 'speech', elapsedMs: 500 },
      { state: 'listening', elapsedMs: 1_100 },
    ]);
    expect(events.filter((event) => event.kind === 'endpoint-reached')).toEqual([
      expect.objectContaining({ captureId: 'capture-1', turnId: 'turn-1' }),
    ]);
    await pipeline.shutdown();
    api.close();
  });

  it('ignores reordered client endpoint signals and publishes one current endpoint', async () => {
    const recorder = new WorkerRecorder();
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith({
        engine: 'mlx-whisper',
        preflight: () => undefined,
        transcribe: vi.fn(async () => 'unused'),
      }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (event) =>
      events.push(event),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(100));
    await beginning;

    recorder.emitActivity({ state: 'speech', levelDbfs: -35, elapsedMs: 500 });
    recorder.emitActivity({ state: 'endpoint', levelDbfs: -80, elapsedMs: 400 });
    expect(events.filter((event) => event.kind === 'endpoint-reached')).toHaveLength(0);

    recorder.emitActivity({ state: 'endpoint', levelDbfs: -80, elapsedMs: 1_100 });
    recorder.emitActivity({ state: 'endpoint', levelDbfs: -80, elapsedMs: 1_200 });
    expect(events.filter((event) => event.kind === 'endpoint-reached')).toEqual([
      expect.objectContaining({ kind: 'endpoint-reached', captureId: 'capture-1', turnId: 'turn-1' }),
    ]);
    await pipeline.shutdown();
  });
  it('falls back to adaptive VAD when neural inference cannot initialize', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const unavailableFactory = vi.fn(() => {
      throw new Error('native runtime unavailable');
    });
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({
        engine: 'mlx-whisper',
        preflight: () => undefined,
        transcribe: vi.fn(async () => 'unused'),
      }),
      speechDetectorFactory: unavailableFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    expect(pipeline.capabilities()).not.toContain('silero-vad');

    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(8_000));
    for (let index = 0; index < 32; index += 1) recorder.emit(pcmFrame(0));
    await beginning;
    clock.advance(2_400);

    expect(unavailableFactory).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'endpoint-reached', turnId: 'turn-1' }));
    await pipeline.shutdown();
  });

  it('clips leading idle while preserving pre-roll, pauses, and one autonomous endpoint', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const transcripts = ['', 'complete long form request'];
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => transcripts.shift() ?? '');
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith(adapter),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    pipeline.initialize(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 0,
        kind: 'initialize',
        spoolDirectory: root,
        activityHz: 8,
      },
      (published) => events.push(published),
    );
    const command = { ...beginCommand(), mode: 'autonomous' as const };
    const beginning = pipeline.handle(command, (published) => events.push(published));
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    const leadingIdleFrames = 150;
    for (let index = 0; index < leadingIdleFrames; index += 1) recorder.emit(pcmFrame(0));
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(6_000));
    for (let index = 0; index < 32; index += 1) recorder.emit(pcmFrame(0));
    clock.advance(1_000);
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(7_000));
    for (let index = 0; index < 32; index += 1) recorder.emit(pcmFrame(0));
    await beginning;
    clock.advance(2_400);

    expect(events.filter((published) => published.kind === 'endpoint-reached')).toEqual([
      expect.objectContaining({
        kind: 'endpoint-reached',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
      }),
    ]);
    expect(transcribe).not.toHaveBeenCalled();

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'soft-endpoint',
      },
      (published) => events.push(published),
    );

    expect(transcribe).toHaveBeenCalledTimes(2);
    const request = transcribe.mock.calls[0]![0] as TranscriptionRequest;
    const expectedPcm = Buffer.concat([
      Buffer.alloc(9 * PCM_FRAME_BYTES),
      ...Array.from({ length: 8 }, () => pcmFrame(6_000)),
      Buffer.alloc(32 * PCM_FRAME_BYTES),
      ...Array.from({ length: 8 }, () => pcmFrame(7_000)),
      Buffer.alloc(32 * PCM_FRAME_BYTES),
    ]);
    expect(fs.readFileSync(request.audioPath).subarray(44)).toEqual(expectedPcm);
    const normalizedRequest = transcribe.mock.calls[1]![0] as TranscriptionRequest;
    expect(normalizedRequest.audioPath).toContain('normalized-1.wav');
    expect(fs.readFileSync(normalizedRequest.audioPath).subarray(44)).toHaveLength(expectedPcm.length);
    const turnDirectory = path.join(root, fs.readdirSync(root)[0]!);
    const manifest = JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8')) as {
      committedBytes: number;
      utteranceStartByte?: number;
    };
    expect(manifest).toMatchObject({
      committedBytes: (leadingIdleFrames + 8 + 32 + 8 + 32) * PCM_FRAME_BYTES,
      utteranceStartByte: (leadingIdleFrames - 9) * PCM_FRAME_BYTES,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'transcript-candidate',
        transcript: 'complete long form request',
        final: true,
      }),
    );
    expect(events.findIndex((published) => published.kind === 'drained')).toBeLessThan(
      events.findIndex((published) => published.kind === 'transcript-candidate'),
    );
    await pipeline.shutdown();
  });

  it('ends a long utterance against stable above-floor room noise', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({
        engine: 'mlx-whisper',
        preflight: () => undefined,
        transcribe: vi.fn(async () => 'long request'),
      }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    const roomNoiseFrame = pcmFrame(128);
    const speechFrame = pcmFrame(6_000);
    const speechFramesPastAmbientRebase = Math.ceil(AMBIENT_REBASE_EXERCISE_MS / PCM_FRAME_MS);
    for (let index = 0; index < 25; index += 1) recorder.emit(roomNoiseFrame);
    for (let index = 0; index < speechFramesPastAmbientRebase; index += 1) recorder.emit(speechFrame);
    for (let index = 0; index < 32; index += 1) recorder.emit(roomNoiseFrame);
    await beginning;

    clock.advance(2_400);

    expect(events).toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    expect(events.filter((published) => published.kind === 'endpoint-reached')).toEqual([
      expect.objectContaining({ kind: 'endpoint-reached', turnId: 'turn-1' }),
    ]);
    await pipeline.shutdown();
  });

  it('excludes playback and its echo tail before accepting a new autonomous utterance', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => 'post narration request');
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith(adapter),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 2,
        active: true,
      },
      (published) => events.push(published),
    );
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(6_000));
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 1,
        active: false,
      },
      (published) => events.push(published),
    );
    clock.advance(900);
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(6_000));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 4,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 2,
        active: false,
      },
      (published) => events.push(published),
    );
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(5_000));
    clock.advance(799);
    recorder.emit(pcmFrame(5_000));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));

    clock.advance(1);
    for (let index = 0; index < 25; index += 1) recorder.emit(pcmFrame(0));
    for (let index = 0; index < 6; index += 1) recorder.emit(pcmFrame(9_000));
    for (let index = 0; index < 30; index += 1) recorder.emit(pcmFrame(0));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));

    clock.advance(2_400);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'endpoint-reached', turnId: 'turn-1' }));
    expect(transcribe).not.toHaveBeenCalled();
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 5,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'soft-endpoint',
      },
      (published) => events.push(published),
    );
    expect(transcribe).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'transcript-candidate',
        transcript: 'post narration request',
        final: true,
      }),
    );
    const request = transcribe.mock.calls[0]![0] as TranscriptionRequest;
    const persistedPcm = fs.readFileSync(request.audioPath).subarray(44);
    const persistedSamples: number[] = [];
    for (let offset = 0; offset < persistedPcm.length; offset += 2)
      persistedSamples.push(persistedPcm.readInt16LE(offset));
    expect(persistedSamples).toContain(9_000);
    expect(persistedSamples).not.toContain(6_000);
    expect(persistedSamples).not.toContain(5_000);
    await pipeline.shutdown();
  });

  it('times out a hung narration probe and schedules the newest pending probe', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const observedSignals: AbortSignal[] = [];
    const transcribe = vi.fn((request: TranscriptionRequest) => {
      const signal = request.signal;
      if (!signal) return Promise.reject(new Error('probe signal unavailable'));
      observedSignals.push(signal);
      return new Promise<string>((_resolve, reject) => {
        const rejectAborted = (): void => reject(new Error('probe aborted'));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener('abort', rejectAborted, { once: true });
      });
    });
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    const publish = (published: VoiceWorkerEventPayload): void => {
      events.push(published);
    };
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, publish);
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 2,
        active: true,
        referenceText: 'The current plan is complete',
        startPhrases: ['hey doom'],
        stopPhrases: ['stop speaking'],
      },
      publish,
    );
    for (let index = 0; index < 85; index += 1) {
      clock.advance(20);
      recorder.emit(pcmFrame(8_000));
    }
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());

    clock.advance(4_500);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));

    expect(observedSignals[0]?.aborted).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'barge-in-evidence' }));
    await pipeline.shutdown();
    expect(observedSignals[1]?.aborted).toBe(true);
  });

  it('holds playback overlap privately until XState-authorized ranked barge-in promotion', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    let transcription = 0;
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => {
      transcription += 1;
      return transcription === 1 ? 'The plan is ready hey doom please run all tests' : 'please run all tests';
    });
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    const publish = (published: VoiceWorkerEventPayload): void => {
      events.push(published);
    };
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, publish);
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 3,
        active: true,
        referenceText: 'The plan is ready',
        startPhrases: ['hey doom'],
        stopPhrases: ['stop speaking'],
      },
      publish,
    );
    for (let index = 0; index < 60; index += 1) {
      clock.advance(20);
      recorder.emit(pcmFrame(9_000));
    }
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ kind: 'barge-in-evidence', playbackGeneration: 3 })),
    );

    const turnDirectory = path.join(root, fs.readdirSync(root)[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8')).committedBytes).toBe(
      PCM_FRAME_BYTES,
    );
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'confirm-barge-in',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        playbackGeneration: 3,
        outcome: 'promote',
      },
      publish,
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    expect(JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8'))).toMatchObject({
      committedBytes: 61 * PCM_FRAME_BYTES,
      utteranceStartByte: 0,
    });

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 4,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 3,
        active: false,
      },
      publish,
    );
    for (let index = 0; index < 30; index += 1) {
      clock.advance(20);
      recorder.emit(pcmFrame(0));
    }
    clock.advance(3_000);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'endpoint-reached', turnId: 'turn-1' }));
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 5,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'soft-endpoint',
      },
      publish,
    );
    expect(transcribe).toHaveBeenCalledTimes(2);
    const finalRequest = transcribe.mock.calls[1]![0] as TranscriptionRequest;
    expect(fs.readFileSync(finalRequest.audioPath).subarray(44)).toEqual(
      Buffer.concat([
        Buffer.alloc(PCM_FRAME_BYTES),
        ...Array.from({ length: 60 }, () => pcmFrame(9_000)),
        Buffer.alloc(30 * PCM_FRAME_BYTES),
      ]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'transcript-candidate', transcript: 'please run all tests' }),
    );
    await pipeline.shutdown();
  });

  it('keeps imperfect self-narration private even when the speech classifier hears it', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => 'The plan was ready for revue');
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    const publish = (published: VoiceWorkerEventPayload): void => {
      events.push(published);
    };
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, publish);
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 5,
        active: true,
        referenceText: 'The plan is ready for review',
        startPhrases: ['hey doom'],
        stopPhrases: ['stop speaking'],
      },
      publish,
    );
    recorder.emitActivity({
      state: 'speech',
      levelDbfs: -34,
      elapsedMs: 200,
      epoch: 1,
      classifiedSpeechMs: 640,
    });
    for (let index = 0; index < 90; index += 1) {
      clock.advance(20);
      recorder.emit(pcmFrame(9_000));
    }

    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));

    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'barge-in-evidence' }));
    const turnDirectory = path.join(root, fs.readdirSync(root)[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8')).committedBytes).toBe(
      PCM_FRAME_BYTES,
    );
    await pipeline.shutdown();
  });
  it('promotes client-classified unaddressed overlap and honors its queued endpoint', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    let transcription = 0;
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => {
      transcription += 1;
      return transcription === 1 ? 'The plan is ready please run all tests' : 'please run all tests';
    });
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    const publish = (published: VoiceWorkerEventPayload): void => {
      events.push(published);
    };
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, publish);
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 5,
        active: true,
        referenceText: 'The plan is ready',
        startPhrases: ['hey doom'],
        stopPhrases: ['stop speaking'],
      },
      publish,
    );
    recorder.emitActivity({
      state: 'speech',
      levelDbfs: -34,
      elapsedMs: 200,
      epoch: 1,
      classifiedSpeechMs: 160,
    });
    for (let index = 0; index < 85; index += 1) {
      clock.advance(20);
      recorder.emit(pcmFrame(9_000));
    }
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
    recorder.emitActivity({
      state: 'endpoint',
      levelDbfs: -75,
      elapsedMs: 1_800,
      epoch: 1,
      classifiedSpeechMs: 160,
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'barge-in-evidence',
          playbackGeneration: 5,
          evidence: expect.objectContaining({
            intentionalAddress: false,
            classifierConfirmed: true,
            classifierSpeechMs: 160,
          }),
        }),
      ),
    );

    const turnDirectory = path.join(root, fs.readdirSync(root)[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8')).committedBytes).toBe(
      PCM_FRAME_BYTES,
    );
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'confirm-barge-in',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        playbackGeneration: 5,
        outcome: 'promote',
      },
      publish,
    );

    expect(events).toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'endpoint-reached', turnId: 'turn-1' }));
    expect(JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8'))).toMatchObject({
      committedBytes: 86 * PCM_FRAME_BYTES,
      utteranceStartByte: PCM_FRAME_BYTES,
    });

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 4,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'soft-endpoint',
      },
      publish,
    );
    expect(transcribe).toHaveBeenCalledTimes(3);
    const finalRequest = transcribe.mock.calls[2]![0] as TranscriptionRequest;
    expect(fs.readFileSync(finalRequest.audioPath).subarray(44)).toEqual(
      Buffer.concat(Array.from({ length: 85 }, () => pcmFrame(9_000))),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'transcript-candidate',
        transcript: 'please run all tests',
        evidence: expect.objectContaining({ classifier: 'client', classifierSpeechMs: 160, playbackOverlapMs: 1_700 }),
      }),
    );
    await pipeline.shutdown();
  });

  it('discards command-only narration interruption audio instead of carrying tail words into input', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    const transcribe = vi.fn(async () => 'The latest commit is four four eight stop speaking');
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe }),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    const root = temporaryRoot();
    const publish = (published: VoiceWorkerEventPayload): void => {
      events.push(published);
    };
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: root,
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, publish);
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(pcmFrame(0));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'playback-state',
        sessionId: 'session-1',
        playbackGeneration: 4,
        active: true,
        referenceText: 'The latest commit is 448900',
        stopPhrases: ['stop speaking'],
      },
      publish,
    );
    for (let index = 0; index < 60; index += 1) {
      clock.advance(20);
      recorder.emit(pcmFrame(7_000));
    }
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'barge-in-evidence',
          evidence: expect.objectContaining({ exactStopCommand: true }),
        }),
      ),
    );
    const turnDirectory = path.join(root, fs.readdirSync(root)[0]!);
    const committedBefore = JSON.parse(
      fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8'),
    ).committedBytes;

    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'confirm-barge-in',
        sessionId: 'session-1',
        captureId: 'capture-1',
        turnId: 'turn-1',
        playbackGeneration: 4,
        outcome: 'discard',
      },
      publish,
    );

    expect(JSON.parse(fs.readFileSync(path.join(turnDirectory, 'manifest.json'), 'utf8')).committedBytes).toBe(
      committedBefore,
    );
    expect(events).not.toContainEqual(expect.objectContaining({ kind: 'capture-state', state: 'speech' }));
    await pipeline.shutdown();
  });

  it('coalesces endpoint and duplicate finalization requests into one final ASR pass', async () => {
    const recorder = new WorkerRecorder();
    const clock = new ScheduledWorkerClock();
    let release!: (value: string) => void;
    const transcribe = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith(adapter),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize({
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 0,
      kind: 'initialize',
      spoolDirectory: temporaryRoot(),
      activityHz: 8,
    });
    const beginning = pipeline.handle({ ...beginCommand(), mode: 'autonomous' as const }, (published) =>
      events.push(published),
    );
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    for (let index = 0; index < 25; index += 1) recorder.emit(pcmFrame(0));
    for (let index = 0; index < 8; index += 1) recorder.emit(pcmFrame(6_000));
    for (let index = 0; index < 32; index += 1) recorder.emit(pcmFrame(0));
    await beginning;
    clock.advance(2_400);
    expect(events.filter((published) => published.kind === 'endpoint-reached')).toHaveLength(1);

    const finalize = {
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: 2,
      kind: 'finalize-capture' as const,
      sessionId: 'session-1',
      captureId: 'capture-1',
      reason: 'soft-endpoint' as const,
    };
    const first = pipeline.handle(finalize, (published) => events.push(published));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    const duplicate = pipeline.handle({ ...finalize, sequence: 3 }, (published) => events.push(published));
    release('one final request');
    await Promise.all([first, duplicate]);

    expect(transcribe).toHaveBeenCalledOnce();
    expect(events.filter((published) => published.kind === 'transcript-candidate')).toEqual([
      expect.objectContaining({ transcript: 'one final request', final: true }),
    ]);
    await pipeline.shutdown();
  });

  it('rate-limits privacy-safe activity metadata to the configured frequency', async () => {
    const recorder = new WorkerRecorder();
    const clock = new WorkerClock();
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe: vi.fn(async () => ''),
    };
    const pipeline = new VoiceWorkerPipeline({
      clock,
      recorder,
      registry: registryWith(adapter),
      speechDetectorFactory,
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 0,
        kind: 'initialize',
        spoolDirectory: temporaryRoot(),
        activityHz: 2,
      },
      (published) => events.push(published),
    );
    const capabilities = pipeline.capabilities();
    expect(capabilities).toContain('adaptive-vad');
    expect(capabilities).toContain('silero-vad');
    expect(capabilities).toContain(VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY);
    expect(capabilities).toContain(VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY);
    expect(capabilities).toContain(VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY);
    expect(capabilities).not.toContain('neural-vad');
    const beginning = pipeline.handle(beginCommand(), (published) => events.push(published));
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(Buffer.alloc(PCM_FRAME_BYTES));
    clock.advance(100);
    recorder.emit(Buffer.alloc(PCM_FRAME_BYTES, 1));
    clock.advance(400);
    recorder.emit(Buffer.alloc(PCM_FRAME_BYTES, 2));
    await beginning;
    const activity = events.filter((published) => published.kind === 'activity');
    expect(activity).toHaveLength(2);
    expect(activity[0]).toEqual(expect.objectContaining({ elapsedMs: 0, levelDbfs: -120, speechProbability: 0 }));
    expect(activity[1]).toEqual(
      expect.objectContaining({ elapsedMs: 500, levelDbfs: expect.any(Number), speechProbability: expect.any(Number) }),
    );
    expect(JSON.stringify(activity)).not.toContain('pcm');
    await pipeline.shutdown();
  });

  it('reports malformed durable spools once while continuing recovery', () => {
    const root = temporaryRoot();
    const corruptDirectory = path.join(root, 'turn-corrupt');
    fs.mkdirSync(corruptDirectory);
    fs.writeFileSync(path.join(corruptDirectory, 'manifest.json'), '{not-json', { mode: 0o600 });

    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder: new WorkerRecorder(),
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe: vi.fn() }),
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 0,
        kind: 'initialize',
        spoolDirectory: root,
        activityHz: 8,
      },
      (published) => events.push(published),
    );

    expect(events).toEqual([{ kind: 'failure', code: 'spool_recovery_failed', recoverable: true }]);
  });

  it('rediscovers, resumes, and acknowledges an uncommitted durable spool after restart', async () => {
    const root = temporaryRoot();
    const spool = NodeTurnSpool.create(root, {
      sessionId: 'session-1',
      captureId: 'capture-1',
      turnId: 'turn-1',
    });
    spool.append(Buffer.alloc(PCM_FRAME_BYTES, 7));
    spool.append(Buffer.alloc(PCM_FRAME_BYTES, 9));
    spool.markUtteranceStart(PCM_FRAME_BYTES);
    spool.createSnapshot();
    spool.close();

    const recorder = new WorkerRecorder();
    const transcribe = vi.fn(async (_request: TranscriptionRequest) => 'recovered complete turn');
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder,
      registry: registryWith(adapter),
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 0,
        kind: 'initialize',
        spoolDirectory: root,
        activityHz: 8,
      },
      (published) => events.push(published),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'recovered', sessionId: 'session-1', turnId: 'turn-1', revision: 1 }),
    );
    const beginning = pipeline.handle(beginCommand(), (published) => events.push(published));
    await vi.waitFor(() => expect(recorder.ready).toBe(true));
    recorder.emit(Buffer.alloc(PCM_FRAME_BYTES, 8));
    await beginning;
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 2,
        kind: 'finalize-capture',
        sessionId: 'session-1',
        captureId: 'capture-1',
        reason: 'explicit-stop',
      },
      (published) => events.push(published),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'transcript-candidate', transcript: 'recovered complete turn', final: true }),
    );
    const request = transcribe.mock.calls[0]![0] as TranscriptionRequest;
    expect(fs.readFileSync(request.audioPath).subarray(44)).toEqual(
      Buffer.concat([Buffer.alloc(PCM_FRAME_BYTES, 9), Buffer.alloc(PCM_FRAME_BYTES, 8)]),
    );
    const manifestPath = path.join(root, fs.readdirSync(root)[0]!, 'manifest.json');
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).gapCount).toBe(1);
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 3,
        kind: 'acknowledge-candidate',
        sessionId: 'session-1',
        turnId: 'turn-1',
        revision: 2,
        outcome: 'committed',
      },
      (published) => events.push(published),
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('cleans acknowledged spools and accepts acknowledgement for recovered inactive work', async () => {
    const root = temporaryRoot();
    const acknowledged = NodeTurnSpool.create(root, {
      sessionId: 'old-session',
      captureId: 'old-capture',
      turnId: 'old-turn',
    });
    acknowledged.append(Buffer.alloc(2));
    acknowledged.createSnapshot();
    acknowledged.acknowledge(1, 'discarded');
    acknowledged.close();
    const pending = NodeTurnSpool.create(root, {
      sessionId: 'pending-session',
      captureId: 'pending-capture',
      turnId: 'pending-turn',
    });
    pending.append(Buffer.alloc(2));
    pending.createSnapshot();
    pending.close();

    const pipeline = new VoiceWorkerPipeline({
      clock: new WorkerClock(),
      recorder: new WorkerRecorder(),
      registry: registryWith({ engine: 'mlx-whisper', preflight: () => undefined, transcribe: vi.fn() }),
    });
    const events: VoiceWorkerEventPayload[] = [];
    pipeline.initialize(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 0,
        kind: 'initialize',
        spoolDirectory: root,
        activityHz: 8,
      },
      (published) => events.push(published),
    );
    expect(events.filter((published) => published.kind === 'recovered')).toHaveLength(1);
    await pipeline.handle(
      {
        version: VOICE_WORKER_PROTOCOL_VERSION,
        sequence: 1,
        kind: 'acknowledge-candidate',
        sessionId: 'pending-session',
        turnId: 'pending-turn',
        revision: 1,
        outcome: 'discarded',
      },
      (published) => events.push(published),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'candidate-acknowledged',
        sessionId: 'pending-session',
        captureId: 'pending-capture',
        turnId: 'pending-turn',
        revision: 1,
        outcome: 'discarded',
      }),
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
