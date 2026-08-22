import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY,
  VOICE_WORKER_PROTOCOL_VERSION,
  VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY,
  VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
  type VoiceCandidateOutcome,
  type VoiceFinalizeReason,
  type VoiceWorkerCaptureConfiguration,
  type VoiceWorkerCommandPayload,
  type VoiceWorkerEvent,
  type VoiceWorkerMode,
} from '../../services/voiceWorkerProtocol.ts';
import { type VoiceWorkerHandle, VoiceWorkerSupervisor } from '../../services/voiceWorkerSupervisor.ts';

export interface VoiceWorkerClientOptions {
  spoolDirectory: string;
  activityHz?: number;
  onEvent: (event: VoiceWorkerEvent) => void;
  onRestart?: (reason: 'error' | 'exit' | 'heartbeat') => void;
  onExhausted?: (reason: 'error' | 'exit' | 'heartbeat') => void;
  workerFactory?: () => VoiceWorkerHandle;
  importUrl?: string | URL;
}

export interface BeginVoiceCaptureInput {
  sessionId: string;
  captureId: string;
  mode: VoiceWorkerMode;
  turnId: string;
  config: VoiceWorkerCaptureConfiguration;
  maxDurationMs: number;
  utteranceIdleMs: number;
  transcriptionTimeoutMs?: number;
}

export function findVoiceWorkerUrl(importFileUrl: string | URL): URL {
  const importFilePath = fileURLToPath(importFileUrl);
  let directory = dirname(importFilePath);

  while (true) {
    const workerPath = join(directory, 'voiceWorker.mjs');
    if (existsSync(workerPath)) return pathToFileURL(workerPath);

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`Cannot find voiceWorker.mjs by walking from ${importFilePath}.`);
}

function createNodeWorker(importUrl?: string | URL): VoiceWorkerHandle {
  const workerUrl = importUrl ? findVoiceWorkerUrl(importUrl) : findVoiceWorkerUrl(import.meta.url);
  return new Worker(workerUrl, { name: 'doompi-voice' }) as VoiceWorkerHandle;
}

export class VoiceWorkerClient {
  private readonly options: VoiceWorkerClientOptions;
  private readonly supervisor: VoiceWorkerSupervisor;
  private sequence = 0;
  private started = false;
  private ready: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private activeCapture: { input: BeginVoiceCaptureInput; finalizeReason?: VoiceFinalizeReason } | undefined;
  private activePlayback:
    | {
        sessionId: string;
        playbackGeneration: number;
        referenceText?: string;
        startPhrases?: readonly string[];
        stopPhrases?: readonly string[];
      }
    | undefined;
  private workerCapabilities = new Set<string>();
  private readyCount = 0;

  public constructor(options: VoiceWorkerClientOptions) {
    this.options = options;
    this.supervisor = new VoiceWorkerSupervisor({
      createWorker: options.workerFactory ?? (() => createNodeWorker(options.importUrl)),
      onEvent: (event) => this.receive(event),
      onSpawn: () => this.initializeWorker(),
      ...(options.onRestart ? { onRestart: options.onRestart } : {}),
      onExhausted: (reason) => {
        this.rejectReady?.(new Error(`Voice worker supervision exhausted after ${reason}.`));
        options.onExhausted?.(reason);
      },
    });
  }

  public start(): Promise<void> {
    if (this.ready) return this.ready;
    this.started = true;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.supervisor.start();
    return this.ready;
  }

  public beginCapture(input: BeginVoiceCaptureInput): void {
    this.activeCapture = { input };
    this.sendBeginCapture(input);
  }

  public finalizeCapture(sessionId: string, captureId: string, reason: VoiceFinalizeReason): void {
    if (this.activeCapture?.input.sessionId === sessionId && this.activeCapture.input.captureId === captureId)
      this.activeCapture.finalizeReason = reason;
    this.send({ kind: 'finalize-capture', sessionId, captureId, reason });
  }

  public cancelCapture(sessionId: string, captureId: string): void {
    if (this.activeCapture?.input.sessionId === sessionId && this.activeCapture.input.captureId === captureId)
      this.activeCapture = undefined;
    this.send({ kind: 'cancel-capture', sessionId, captureId });
  }

  public acknowledgeCandidate(
    sessionId: string,
    turnId: string,
    revision: number,
    outcome: VoiceCandidateOutcome,
  ): void {
    if (
      outcome !== 'retry' &&
      this.activeCapture?.input.sessionId === sessionId &&
      this.activeCapture.input.turnId === turnId
    )
      this.activeCapture = undefined;
    this.send({ kind: 'acknowledge-candidate', sessionId, turnId, revision, outcome });
  }

  public setPlaybackState(
    sessionId: string,
    playbackGeneration: number,
    active: boolean,
    reference?: { text: string; startPhrases: readonly string[]; stopPhrases: readonly string[] },
  ): void {
    if (active) {
      this.activePlayback = {
        sessionId,
        playbackGeneration,
        ...(reference
          ? {
              referenceText: reference.text,
              startPhrases: [...reference.startPhrases],
              stopPhrases: [...reference.stopPhrases],
            }
          : {}),
      };
    } else if (
      this.activePlayback?.sessionId === sessionId &&
      playbackGeneration >= this.activePlayback.playbackGeneration
    ) {
      this.activePlayback = undefined;
    }
    this.sendPlaybackState(sessionId, playbackGeneration, active, reference);
  }

  public confirmBargeIn(
    sessionId: string,
    captureId: string,
    turnId: string,
    playbackGeneration: number,
    outcome: 'promote' | 'discard',
  ): void {
    if (!this.workerCapabilities.has(VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY)) return;
    this.send({ kind: 'confirm-barge-in', sessionId, captureId, turnId, playbackGeneration, outcome });
  }

  public async shutdown(reason: 'session-shutdown' | 'extension-dispose'): Promise<void> {
    if (!this.started) return;
    const rejectPendingStartup = this.rejectReady;
    try {
      this.send({ kind: 'shutdown', reason });
    } finally {
      this.started = false;
      this.ready = undefined;
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      this.activeCapture = undefined;
      this.activePlayback = undefined;
      this.workerCapabilities.clear();
      this.readyCount = 0;
      rejectPendingStartup?.(new Error(`Voice worker startup was cancelled by ${reason}.`));
      await this.supervisor.stop();
    }
  }

  private receive(event: VoiceWorkerEvent): void {
    if (event.kind === 'ready') {
      const restarted = this.readyCount > 0;
      this.workerCapabilities = new Set(event.capabilities);
      this.readyCount += 1;
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      if (restarted) this.resumeActiveCapture();
    } else if (event.kind === 'failure' && event.code === 'initialization_failed') {
      this.rejectReady?.(new Error('Voice worker initialization failed.'));
    }
    this.options.onEvent(event);
  }

  private resumeActiveCapture(): void {
    const active = this.activeCapture;
    if (!active) return;
    this.sendBeginCapture(active.input);
    if (active.finalizeReason)
      this.send({
        kind: 'finalize-capture',
        sessionId: active.input.sessionId,
        captureId: active.input.captureId,
        reason: active.finalizeReason,
      });
    const playback = this.activePlayback;
    if (playback)
      this.sendPlaybackState(
        playback.sessionId,
        playback.playbackGeneration,
        true,
        playback.referenceText
          ? {
              text: playback.referenceText,
              startPhrases: playback.startPhrases ?? [],
              stopPhrases: playback.stopPhrases ?? [],
            }
          : undefined,
      );
  }

  private sendPlaybackState(
    sessionId: string,
    playbackGeneration: number,
    active: boolean,
    reference?: { text: string; startPhrases: readonly string[]; stopPhrases: readonly string[] },
  ): void {
    const supportsBargeIn = this.workerCapabilities.has(VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY);
    const supportsIntentionalAddress = this.workerCapabilities.has(VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY);
    this.send({
      kind: 'playback-state',
      sessionId,
      playbackGeneration,
      active,
      ...(active && reference && supportsBargeIn
        ? {
            referenceText: reference.text,
            ...(supportsIntentionalAddress ? { startPhrases: [...reference.startPhrases] } : {}),
            stopPhrases: [...reference.stopPhrases],
          }
        : {}),
    });
  }

  private sendBeginCapture(input: BeginVoiceCaptureInput): void {
    const { transcriptionTimeoutMs, ...compatibleInput } = input;
    this.send({
      kind: 'begin-capture',
      ...compatibleInput,
      ...(transcriptionTimeoutMs !== undefined &&
      this.workerCapabilities.has(VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY)
        ? { transcriptionTimeoutMs }
        : {}),
    });
  }

  private initializeWorker(): void {
    this.send({
      kind: 'initialize',
      spoolDirectory: this.options.spoolDirectory,
      activityHz: this.options.activityHz ?? 8,
    });
  }

  private send(command: VoiceWorkerCommandPayload): void {
    if (!this.started) throw new Error('Voice worker client has not been started.');
    this.supervisor.postMessage({
      ...command,
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: this.sequence,
    });
    this.sequence += 1;
  }
}
