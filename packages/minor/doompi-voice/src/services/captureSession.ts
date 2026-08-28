import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import type { IClock, IPcmAudioRecorder, LiveRecordingHandle, TimerHandle } from '../types/index.ts';
import type { VoiceMediaCaptureActivity, VoiceMediaCaptureConfiguration } from '../types/clientMedia.ts';
import { PCM_BYTES_PER_SAMPLE } from './pcm.ts';
import type { ITurnSpool, TurnSnapshot } from './turnSpool.ts';

const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 8_000;
const DEFAULT_LIVENESS_CHECK_MS = 1_000;
const DEFAULT_STALE_FRAME_MS = 4_000;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3;

export type CaptureSessionState = 'idle' | 'starting' | 'capturing' | 'recovering' | 'draining' | 'closed';

export interface CaptureSessionOptions {
  recorder: IPcmAudioRecorder;
  config: ResolvedVoiceConfig;
  spool: ITurnSpool;
  clock: IClock;
  firstFrameTimeoutMs?: number;
  livenessCheckMs?: number;
  staleFrameMs?: number;
  maxRecoveryAttempts?: number;
  onFrame?: (frame: Buffer, captureGeneration: number) => void;
  capture?: VoiceMediaCaptureConfiguration;
  onClientActivity?: (activity: VoiceMediaCaptureActivity, captureGeneration: number) => void;
  shouldPersistPcm?(captureGeneration: number): boolean;
  onGap?: (gapCount: number) => void;
  onStateChange?: (state: CaptureSessionState) => void;
}

interface Readiness {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function readiness(): Readiness {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ready, failed) => {
    resolve = ready;
    reject = failed;
  });
  return { promise, resolve, reject };
}

function processError(result: { code: number; stderr: string }): Error {
  return new Error(result.stderr || `Voice recorder exited with code ${result.code}.`);
}

export class CaptureSession {
  private readonly options: CaptureSessionOptions;
  private handle: LiveRecordingHandle | undefined;
  private livenessTimer: TimerHandle | undefined;
  private startupTimer: TimerHandle | undefined;
  private recovery: Promise<void> | undefined;
  private captureGeneration = 0;
  private recoveryAttempts = 0;
  private lastFrameAt = 0;
  private accepting = false;
  private stopping = false;
  private currentState: CaptureSessionState = 'idle';

  public constructor(options: CaptureSessionOptions) {
    this.options = options;
    this.captureGeneration = options.spool.snapshotManifest().captureGeneration;
  }

  public get state(): CaptureSessionState {
    return this.currentState;
  }

  public async start(): Promise<void> {
    if (this.currentState !== 'idle') throw new Error('Voice capture session has already started.');
    this.accepting = true;
    this.stopping = false;
    await this.launchWithRecovery();
  }

  public async drain(): Promise<TurnSnapshot> {
    if (this.currentState !== 'capturing' && this.currentState !== 'recovering')
      throw new Error('Voice capture session is not active.');
    this.stopping = true;
    this.setState('draining');
    this.clearLiveness();
    const handle = this.handle;
    const remainder = handle ? await handle.stop() : Buffer.alloc(0);
    await this.recovery?.catch(() => undefined);
    const discardedBytes = this.appendCompleteSamples(remainder, this.captureGeneration);
    this.accepting = false;
    this.handle = undefined;
    if (discardedBytes > 0) throw new Error('Voice recorder returned an incomplete trailing PCM sample.');
    const snapshot = this.options.spool.createSnapshot();
    this.setState('closed');
    return snapshot;
  }

  public async abort(): Promise<void> {
    if (this.currentState === 'closed') return;
    this.stopping = true;
    this.accepting = false;
    this.clearStartup();
    this.clearLiveness();
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await handle.abort();
    this.options.spool.close();
    this.setState('closed');
  }

  private async launchWithRecovery(): Promise<void> {
    let lastError: Error | undefined;
    while (
      !this.stopping &&
      this.recoveryAttempts <= (this.options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS)
    ) {
      try {
        await this.launchRecorder();
        this.recoveryAttempts = 0;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const failedHandle = this.handle;
        this.handle = undefined;
        if (failedHandle) {
          const remainder = await failedHandle.abort().catch(() => undefined);
          this.appendCompleteSamples(remainder ?? Buffer.alloc(0), this.captureGeneration);
        }
        if (this.stopping) break;
        this.recordGap();
        this.recoveryAttempts += 1;
        this.setState('recovering');
      }
    }
    this.accepting = false;
    this.setState('closed');
    throw lastError ?? new Error('Voice recorder recovery was exhausted.');
  }

  private async launchRecorder(): Promise<void> {
    this.setState('starting');
    const generation = this.captureGeneration + 1;
    this.captureGeneration = generation;
    this.options.spool.setCaptureGeneration(generation);
    const ready = readiness();
    let sawFirstFrame = false;
    const handle = this.options.recorder.start(
      this.options.config,
      (frame) => {
        if (!this.accepting || generation !== this.captureGeneration) return;
        if (this.options.shouldPersistPcm?.(generation) !== false) this.options.spool.append(frame);
        this.lastFrameAt = this.options.clock.now();
        this.options.onFrame?.(frame, generation);
        if (!sawFirstFrame) {
          sawFirstFrame = true;
          ready.resolve();
        }
      },
      {
        capture: this.options.capture ?? { mode: 'manual', activityControl: 'host' },
        onClientActivity: (activity) => {
          if (this.accepting && generation === this.captureGeneration)
            this.options.onClientActivity?.(activity, generation);
        },
      },
    );
    this.handle = handle;
    this.startupTimer = this.options.clock.setTimeout(() => {
      if (!sawFirstFrame && generation === this.captureGeneration)
        ready.reject(new Error('Voice recorder did not produce its first PCM frame in time.'));
    }, this.options.firstFrameTimeoutMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS);

    void handle.completion.then(
      (result) => {
        if (this.stopping || generation !== this.captureGeneration) return;
        if (!sawFirstFrame) {
          ready.reject(processError(result));
          return;
        }
        void this.recover(processError(result));
      },
      (error: unknown) => {
        if (this.stopping || generation !== this.captureGeneration) return;
        const recorderError = error instanceof Error ? error : new Error(String(error));
        if (!sawFirstFrame) ready.reject(recorderError);
        else void this.recover(recorderError);
      },
    );

    try {
      await ready.promise;
    } finally {
      this.clearStartup();
    }
    if (this.stopping || generation !== this.captureGeneration) return;
    this.setState('capturing');
    this.startLiveness(generation);
  }

  private recover(_error: Error): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.recovery ??= this.performRecovery().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  private async performRecovery(): Promise<void> {
    this.clearLiveness();
    this.setState('recovering');
    const failedHandle = this.handle;
    this.handle = undefined;
    if (failedHandle) {
      const remainder = await failedHandle.abort().catch(() => undefined);
      this.appendCompleteSamples(remainder ?? Buffer.alloc(0), this.captureGeneration);
    }
    if (this.stopping) return;
    this.recordGap();
    this.recoveryAttempts += 1;
    await this.launchWithRecovery();
  }

  private appendCompleteSamples(pcm: Buffer, captureGeneration: number): number {
    const completeBytes = pcm.length - (pcm.length % PCM_BYTES_PER_SAMPLE);
    if (completeBytes > 0 && this.options.shouldPersistPcm?.(captureGeneration) !== false)
      this.options.spool.append(pcm.subarray(0, completeBytes));
    return pcm.length - completeBytes;
  }

  private recordGap(): void {
    this.options.spool.recordGap();
    this.options.onGap?.(this.options.spool.snapshotManifest().gapCount);
  }

  private startLiveness(generation: number): void {
    this.clearLiveness();
    this.lastFrameAt = this.options.clock.now();
    this.livenessTimer = this.options.clock.setInterval(() => {
      if (this.stopping || generation !== this.captureGeneration) return;
      const staleMs = this.options.staleFrameMs ?? DEFAULT_STALE_FRAME_MS;
      if (this.options.clock.now() - this.lastFrameAt > staleMs)
        void this.recover(new Error('Voice recorder stopped producing PCM frames.'));
    }, this.options.livenessCheckMs ?? DEFAULT_LIVENESS_CHECK_MS);
  }

  private clearStartup(): void {
    if (!this.startupTimer) return;
    this.options.clock.clear(this.startupTimer);
    this.startupTimer = undefined;
  }

  private clearLiveness(): void {
    if (!this.livenessTimer) return;
    this.options.clock.clear(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  private setState(state: CaptureSessionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.options.onStateChange?.(state);
  }
}
