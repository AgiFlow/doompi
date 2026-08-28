import os from 'node:os';
import path from 'node:path';

import { resolveVoiceConfig } from '@agimon-ai/doompi-config/config';
import { type IDoomConfigLoader, type ResolvedVoiceConfig } from '@agimon-ai/doompi-config/types';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { DEFAULT_TRANSCRIPTION_TIMEOUT_MS } from '../../services/turnTranscriber.ts';
import type {
  VoiceCandidateOutcome,
  VoiceFinalizeReason,
  VoiceWorkerCaptureConfiguration,
  VoiceWorkerEvent,
} from '../../services/voiceWorkerProtocol.ts';
import type {
  IClock,
  IVoiceSessionController,
  TimerHandle,
  VoiceActivityUpdate,
  VoiceState,
  VoiceUi,
} from '../../types/index.ts';
import { type BeginVoiceCaptureInput, VoiceWorkerClient, type VoiceWorkerClientOptions } from './voiceWorkerClient.ts';

const STATUS_KEY = 'doom-voice';
const ACTIVITY_INTERVAL_MS = 120;
const MAX_RECORDING_MS = 300_000;
let identifierSequence = 0;

function identifier(prefix: string): string {
  identifierSequence += 1;
  return `${prefix}-${Date.now()}-${identifierSequence}`;
}

function spoolRoot(): string {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDirectory, 'doom-voice', 'spool');
}

function workerConfiguration(config: ResolvedVoiceConfig): VoiceWorkerCaptureConfiguration {
  return {
    engine: config.engine,
    language: config.language,
    recorder: { ...config.recorder },
    adapters: { ...config.adapters },
  };
}

export interface VoiceWorkerSessionClient {
  start(): Promise<void>;
  beginCapture(input: BeginVoiceCaptureInput): void;
  finalizeCapture(sessionId: string, captureId: string, reason: VoiceFinalizeReason): void;
  cancelCapture(sessionId: string, captureId: string): void;
  acknowledgeCandidate(sessionId: string, turnId: string, revision: number, outcome: VoiceCandidateOutcome): void;
  setPlaybackState?(
    sessionId: string,
    playbackGeneration: number,
    active: boolean,
    reference?: { text: string; stopPhrases: readonly string[] },
  ): void;
  confirmBargeIn?(
    sessionId: string,
    captureId: string,
    turnId: string,
    playbackGeneration: number,
    outcome: 'promote' | 'discard',
  ): void;
  shutdown(reason: 'session-shutdown'): Promise<void>;
}

export type VoiceWorkerSessionClientFactory = (options: VoiceWorkerClientOptions) => VoiceWorkerSessionClient;

export class VoiceWorkerSessionController implements IVoiceSessionController {
  private currentState: VoiceState = 'idle';
  private client: VoiceWorkerSessionClient | undefined;
  private config: ResolvedVoiceConfig | undefined;
  private sessionId = identifier('session');
  private captureId: string | undefined;
  private turnId: string | undefined;
  private startedAt = 0;
  private generation = 0;
  private activityFrame = 0;
  private activityTimer: TimerHandle | undefined;
  private readonly telemetry = createDoomTelemetry({
    serviceName: 'doom-voice',
    packageName: '@agimon-ai/doompi-voice',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });

  public constructor(
    private readonly configs: IDoomConfigLoader,
    private readonly clock: IClock,
    private readonly clientFactory: VoiceWorkerSessionClientFactory = (options) => new VoiceWorkerClient(options),
  ) {}

  public get state(): VoiceState {
    return this.currentState;
  }

  public async toggle(ui: VoiceUi): Promise<void> {
    if (this.currentState === 'transcribing') {
      ui.notify('Voice transcription is already running', 'info');
      return;
    }
    if (this.currentState === 'recording') {
      this.finalize(ui);
      return;
    }
    await this.begin(ui);
  }

  public async shutdown(ui?: VoiceUi): Promise<void> {
    this.generation += 1;
    this.clearActivity();
    if (this.client && this.captureId) this.client.cancelCapture(this.sessionId, this.captureId);
    await this.client?.shutdown('session-shutdown');
    this.client = undefined;
    this.reset(ui);
    await this.telemetry.shutdown();
  }

  private async begin(ui: VoiceUi): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    try {
      const projectRoot = process.env.PI_PROJECT_ROOT ?? process.cwd();
      const loaded = this.configs.load(projectRoot).voice;
      if (!loaded) throw new Error('Voice is not configured in the Pi agent configuration.');
      const config = resolveVoiceConfig(loaded);
      const captureId = identifier('capture');
      const turnId = identifier('turn');
      const client = this.client ?? this.createClient(ui);
      this.client = client;
      await client.start();
      if (generation !== this.generation) return;
      this.config = config;
      this.captureId = captureId;
      this.turnId = turnId;
      this.startedAt = this.clock.now();
      this.currentState = 'recording';
      this.startActivity(ui);
      client.beginCapture({
        sessionId: this.sessionId,
        captureId,
        turnId,
        mode: 'manual',
        config: workerConfiguration(config),
        maxDurationMs: MAX_RECORDING_MS,
        utteranceIdleMs: config.autoCapture?.utteranceIdleMs ?? 3_000,
        transcriptionTimeoutMs: config.autoCapture?.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
      });
      void this.telemetry.recordEvent('doom_voice.recording_started', {
        engine: config.engine,
        outcome: 'started',
      });
    } catch (error) {
      if (generation !== this.generation) return;
      await this.telemetry.recordError('doom_voice.recording_failed', error, { outcome: 'failed' });
      this.reset(ui);
      ui.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private finalize(ui: VoiceUi): void {
    if (!this.client || !this.captureId || this.currentState !== 'recording') return;
    this.currentState = 'transcribing';
    this.startActivity(ui);
    this.client.finalizeCapture(this.sessionId, this.captureId, 'explicit-stop');
    void this.telemetry.recordEvent('doom_voice.transcription_started', {
      engine: this.config?.engine ?? 'unknown',
      duration_ms: Math.max(0, this.clock.now() - this.startedAt),
    });
  }

  private createClient(ui: VoiceUi): VoiceWorkerSessionClient {
    return this.clientFactory({
      spoolDirectory: spoolRoot(),
      onEvent: (event) => this.receive(event, ui),
      onExhausted: () => {
        ui.notify('Voice worker stopped responding', 'error');
        this.reset(ui);
      },
    });
  }

  private receive(event: VoiceWorkerEvent, ui: VoiceUi): void {
    if ('sessionId' in event && event.sessionId !== this.sessionId) return;
    if ('captureId' in event && event.captureId !== undefined && event.captureId !== this.captureId) return;
    if (event.kind === 'capture-state') {
      if (event.state === 'processing' || event.state === 'draining') {
        this.currentState = 'transcribing';
        this.startActivity(ui);
      }
      return;
    }
    if (event.kind === 'transcript-candidate') {
      if (event.turnId !== this.turnId || !event.final) return;
      const draft = ui.getEditorText();
      ui.setEditorText(`${draft}${draft && !/\s$/u.test(draft) ? ' ' : ''}${event.transcript}`);
      this.client?.acknowledgeCandidate(event.sessionId, event.turnId, event.revision, 'committed');
      void this.telemetry.recordEvent('doom_voice.transcription_finished', {
        engine: this.config?.engine ?? 'unknown',
        duration_ms: Math.max(0, this.clock.now() - this.startedAt),
        result_characters: event.transcript.length,
        outcome: 'completed',
      });
      this.reset(ui);
      return;
    }
    if (event.kind !== 'failure') return;
    if (event.code === 'empty_transcript' && event.revision !== undefined && event.sessionId && event.turnId) {
      this.client?.acknowledgeCandidate(event.sessionId, event.turnId, event.revision, 'discarded');
      ui.notify('Voice transcription was empty', 'info');
      void this.telemetry.recordEvent('doom_voice.transcription_finished', {
        engine: this.config?.engine ?? 'unknown',
        duration_ms: Math.max(0, this.clock.now() - this.startedAt),
        result_characters: 0,
        outcome: 'empty',
      });
    } else {
      ui.notify(`Voice processing failed: ${event.code}`, 'error');
    }
    this.reset(ui);
  }

  private startActivity(ui: VoiceUi): void {
    this.clearActivity();
    this.activityFrame = 0;
    this.publishActivity(ui);
    this.activityTimer = this.clock.setInterval(() => {
      this.activityFrame += 1;
      this.publishActivity(ui);
    }, ACTIVITY_INTERVAL_MS);
  }

  private publishActivity(ui: VoiceUi): void {
    if (this.currentState === 'idle') return;
    const update: VoiceActivityUpdate = {
      state: this.currentState,
      frameIndex: this.activityFrame,
      ...(this.currentState === 'recording'
        ? { elapsedSeconds: Math.max(0, Math.floor((this.clock.now() - this.startedAt) / 1_000)) }
        : {}),
    };
    ui.setIndicator(update);
    ui.setStatus(STATUS_KEY, this.currentState === 'recording' ? 'voice: recording' : 'voice: transcribing');
  }

  private clearActivity(): void {
    if (this.activityTimer) this.clock.clear(this.activityTimer);
    this.activityTimer = undefined;
  }

  private reset(ui?: VoiceUi): void {
    this.clearActivity();
    this.config = undefined;
    this.captureId = undefined;
    this.turnId = undefined;
    this.currentState = 'idle';
    this.activityFrame = 0;
    ui?.setIndicator(undefined);
    ui?.setStatus(STATUS_KEY, undefined);
  }
}
