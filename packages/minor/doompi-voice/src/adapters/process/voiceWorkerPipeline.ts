import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { AutonomousEndpoint } from '../../services/autonomousEndpoint.ts';
import { CaptureSession } from '../../services/captureSession.ts';
import {
  type NarrationBargeInEvidence,
  NarrationBargeInMonitor,
  type NarrationBargeInProbe,
} from '../../services/narrationBargeIn.ts';
import { PCM_FRAME_BYTES, PCM_FRAME_MS } from '../../services/pcm.ts';
import { PlaybackGate } from '../../services/playbackGate.ts';
import { analyzePcm16, normalizePcm16 } from '../../services/transcriptionCoordinator.ts';
import type { VoiceTranscriptSignalEvidence } from '../../services/transcriptAdmission.ts';
import {
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  TurnTranscriber,
  type TurnTranscriptionOutcome,
} from '../../services/turnTranscriber.ts';
import {
  AdaptiveVoiceActivityDetector,
  calculatePcmFrameDbfs,
  DEFAULT_VAD_CONFIGURATION,
  type VadNoiseProfile,
} from '../../services/vad.ts';
import {
  VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY,
  VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY,
  VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
  type VoiceWorkerCommand,
} from '../../services/voiceWorkerProtocol.ts';
import type {
  IClock,
  IPcmAudioRecorder,
  ISpeechPresenceDetector,
  ITranscriberRegistry,
  SelectedTranscriber,
  TimerHandle,
  TranscriptionAdapterOutput,
} from '../../types/index.ts';
import type { VoiceMediaCaptureActivity } from '../../types/clientMedia.ts';
import {
  ExecutableResolver,
  FfmpegPcmAudioRecorder,
  NodeBinaryProcessSpawner,
  NodeProcessSpawner,
  SystemClock,
  writePrivatePcm16Wav,
} from '../audio/infrastructure.ts';
import { ClientPcmAudioRecorder, voiceMediaHostConnection } from '../audio/clientMedia.ts';
import { SileroSpeechPresenceDetector } from '../audio/silero.ts';
import {
  MlxWhisperAdapter,
  OpenAiWhisperAdapter,
  TranscriberRegistry,
  WhisperCppAdapter,
} from '../transcription/whisper.ts';
import { NodeTurnSpool } from './turnSpool.ts';
import type { VoiceWorkerPublish, VoiceWorkerRuntimeHooks } from './voiceWorker.ts';

const MAX_SESSION_NOISE_PROFILES = 8;
const BARGE_IN_PROBE_TIMEOUT_MS = 5_000;
const AUTONOMOUS_PRE_ROLL_BYTES = (DEFAULT_VAD_CONFIGURATION.preRollMs / PCM_FRAME_MS) * PCM_FRAME_BYTES;

interface ActiveWorkerCapture {
  command: Extract<VoiceWorkerCommand, { kind: 'begin-capture' }>;
  config: ResolvedVoiceConfig;
  selected: SelectedTranscriber;
  spool: NodeTurnSpool;
  session: CaptureSession;
  transcriptionAbort: AbortController;
  vad?: AdaptiveVoiceActivityDetector;
  speechDetector?: ISpeechPresenceDetector;
  bargeIn?: NarrationBargeInMonitor;
  limitTimer?: TimerHandle;
  endpoint: AutonomousEndpoint;
  endpointReported: boolean;
  endpointGeneration?: number;
  clientActivityState?: VoiceMediaCaptureActivity['state'];
  clientActivityElapsedMs: number;
  clientActivityEpoch: number;
  clientActivityGeneration: number;
  clientActivityObserved: boolean;
  clientActivitySpeechMs: number;
  clientActivityEchoDiscriminatedSpeechMs: number;
  clientClassifierSpeechMs: number;
  clientEchoDiscriminatedSpeechMs: number;
  hostClassifierSpeechMs: number;
  bargeInClientClassifierBaselineMs: number;
  bargeInEchoDiscriminatedBaselineMs: number;
  bargeInHostClassifierBaselineMs: number;
  bargeInEchoDiscriminationAvailable: boolean;
  playbackOverlapMs: number;
  clientSpeechStarted: boolean;
  finalized: boolean;
  startedAt: number;
  nextActivityAt: number;
}

function spoolKey(identity: { sessionId: string; turnId: string }): string {
  return `${identity.sessionId}\u0000${identity.turnId}`;
}

function recoverTurnSpool(directory: string): NodeTurnSpool | undefined {
  try {
    return NodeTurnSpool.recover(directory);
  } catch {
    return undefined;
  }
}

function resolvedConfig(command: Extract<VoiceWorkerCommand, { kind: 'begin-capture' }>): ResolvedVoiceConfig {
  return {
    engine: command.config.engine,
    language: command.config.language,
    recorder: { ...command.config.recorder },
    adapters: { ...command.config.adapters },
  };
}

function matchesCapture(active: ActiveWorkerCapture, command: { sessionId: string; captureId?: string }): boolean {
  return (
    active.command.sessionId === command.sessionId &&
    (command.captureId === undefined || active.command.captureId === command.captureId)
  );
}

function clientActivityOrder(state: VoiceMediaCaptureActivity['state']): number {
  return state === 'listening' ? 0 : state === 'speech' ? 1 : 2;
}
function isDeterministicNoSpeech(summary: ReturnType<typeof analyzePcm16>, classifierSpeechMs: number): boolean {
  if (summary.nonZeroSamples === 0) return true;
  if (classifierSpeechMs >= 80) return false;
  const stableAmbient =
    classifierSpeechMs === 0 && summary.durationMs >= 200 && summary.signalVariationDb < 1.5 && summary.rmsDbfs < -42;
  const isolatedTransient = summary.voicedMs < 120 && summary.nonZeroRatio < 0.05;
  return stableAmbient || isolatedTransient;
}

export interface VoiceWorkerPipelineDependencies {
  clock?: IClock;
  recorder?: IPcmAudioRecorder;
  registry?: ITranscriberRegistry;
  speechDetectorFactory?: () => ISpeechPresenceDetector;
}

export class VoiceWorkerPipeline implements VoiceWorkerRuntimeHooks {
  private readonly clock: IClock;
  private readonly recorder: IPcmAudioRecorder;
  private readonly registry: ITranscriberRegistry;
  private readonly speechDetectorFactory: () => ISpeechPresenceDetector;
  private readonly turnTranscriber: TurnTranscriber;
  private spoolDirectory: string | undefined;
  private activityIntervalMs = 125;
  private active: ActiveWorkerCapture | undefined;
  private readonly playbackGate = new PlaybackGate();
  private readonly recovered = new Map<string, NodeTurnSpool>();
  private readonly sessionNoiseProfiles = new Map<string, VadNoiseProfile>();
  private activePlaybackReference: Extract<VoiceWorkerCommand, { kind: 'playback-state' }> | undefined;
  private speechDetector: ISpeechPresenceDetector | undefined;
  private speechDetectorUnavailable = false;
  private operations: Promise<void> = Promise.resolve();
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(dependencies: VoiceWorkerPipelineDependencies = {}) {
    this.clock = dependencies.clock ?? new SystemClock();
    this.speechDetectorFactory = dependencies.speechDetectorFactory ?? (() => new SileroSpeechPresenceDetector());
    this.turnTranscriber = new TurnTranscriber(this.clock);
    if (dependencies.recorder && dependencies.registry) {
      this.recorder = dependencies.recorder;
      this.registry = dependencies.registry;
      return;
    }
    const executables = new ExecutableResolver();
    const processSpawner = new NodeProcessSpawner();
    const clientMedia = voiceMediaHostConnection();
    this.recorder =
      dependencies.recorder ??
      (clientMedia
        ? new ClientPcmAudioRecorder(clientMedia)
        : new FfmpegPcmAudioRecorder(executables, new NodeBinaryProcessSpawner(), this.clock));
    this.registry =
      dependencies.registry ??
      new TranscriberRegistry(
        new WhisperCppAdapter(executables, processSpawner),
        new OpenAiWhisperAdapter(executables, processSpawner),
        new MlxWhisperAdapter(executables, processSpawner),
      );
  }

  public initialize(
    command: Extract<VoiceWorkerCommand, { kind: 'initialize' }>,
    publish: VoiceWorkerPublish = () => undefined,
  ): void {
    this.spoolDirectory = command.spoolDirectory;
    this.activityIntervalMs = Math.max(1, Math.ceil(1_000 / command.activityHz));
    this.playbackGate.reset();
    this.activePlaybackReference = undefined;
    this.recoverSpools(command.spoolDirectory, publish);
  }

  public capabilities(): readonly string[] {
    const speechDetectorAvailable = this.ensureSpeechDetector() !== undefined;
    return [
      'capture',
      'transcription',
      'durable-spool',
      'adaptive-vad',
      ...(speechDetectorAvailable ? ['silero-vad'] : []),
      VOICE_WORKER_TRANSCRIPTION_TIMEOUT_CAPABILITY,
      VOICE_WORKER_RANKED_BARGE_IN_CAPABILITY,
      VOICE_WORKER_INTENTIONAL_BARGE_IN_CAPABILITY,
    ];
  }

  public handle(
    command: Exclude<VoiceWorkerCommand, { kind: 'initialize' | 'shutdown' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> {
    if (this.closing) return Promise.reject(new Error('voice_worker_pipeline_closed'));
    const operation = this.operations.then(() => this.handleOrdered(command, publish));
    this.operations = operation.catch(() => undefined);
    return operation;
  }

  public shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.closing = true;
    const cancellation = this.cancelActive();
    await Promise.all([this.operations, cancellation]);
    for (const spool of this.recovered.values()) {
      if (spool.snapshotManifest().acknowledgedRevision !== undefined) spool.remove();
      else spool.close();
    }
    this.recovered.clear();
  }

  private async handleOrdered(
    command: Exclude<VoiceWorkerCommand, { kind: 'initialize' | 'shutdown' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> {
    if (this.closing) return;
    switch (command.kind) {
      case 'begin-capture':
        await this.begin(command, publish);
        return;
      case 'finalize-capture':
        await this.finalize(command, publish);
        return;
      case 'cancel-capture':
        if (this.active && matchesCapture(this.active, command)) await this.cancelActive();
        return;
      case 'acknowledge-candidate': {
        if (command.outcome === 'retry') return;
        if (this.active && matchesCapture(this.active, command) && this.active.command.turnId === command.turnId) {
          const { command: activeCommand, spool } = this.active;
          spool.acknowledge(command.revision, command.outcome);
          this.recovered.set(spoolKey(activeCommand), spool);
          this.active = undefined;
          publish({
            kind: 'candidate-acknowledged',
            sessionId: activeCommand.sessionId,
            captureId: activeCommand.captureId,
            turnId: activeCommand.turnId,
            revision: command.revision,
            outcome: command.outcome,
          });
          return;
        }
        const recovered = this.recovered.get(spoolKey(command));
        if (!recovered) return;
        const manifest = recovered.snapshotManifest();
        recovered.acknowledge(command.revision, command.outcome);
        publish({
          kind: 'candidate-acknowledged',
          sessionId: manifest.sessionId,
          captureId: manifest.captureId,
          turnId: manifest.turnId,
          revision: command.revision,
          outcome: command.outcome,
        });
        return;
      }
      case 'playback-state':
        this.updatePlaybackGate(command);
        return;
      case 'confirm-barge-in':
        this.promoteBargeIn(command, publish);
        return;
    }
  }

  private async begin(
    command: Extract<VoiceWorkerCommand, { kind: 'begin-capture' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> {
    if (this.active) throw new Error('capture_already_active');
    if (!this.spoolDirectory) throw new Error('spool_not_initialized');
    const config = resolvedConfig(command);
    this.recorder.preflight(config);
    const selected = this.registry.select(config);
    const speechDetector = command.mode === 'autonomous' ? this.prepareSpeechDetector() : undefined;
    this.pruneAcknowledgedSpools(command.sessionId, command.turnId);
    const recoveredKey = spoolKey(command);
    const recovered = this.recovered.get(recoveredKey);
    const recoveredManifest = recovered?.snapshotManifest();
    if (recoveredManifest?.captureId !== undefined && recoveredManifest.captureId !== command.captureId)
      throw new Error('recovered_capture_identity_mismatch');
    if (recoveredManifest?.acknowledgedRevision !== undefined) throw new Error('recovered_turn_already_acknowledged');
    const spool =
      recovered ??
      NodeTurnSpool.create(this.spoolDirectory, {
        sessionId: command.sessionId,
        captureId: command.captureId,
        turnId: command.turnId,
      });
    const frozenSnapshot =
      recoveredManifest && recoveredManifest.revision > 0 ? spool.getSnapshot(recoveredManifest.revision) : undefined;
    if (recovered) {
      this.recovered.delete(recoveredKey);
      if (!frozenSnapshot) spool.recordGap();
    }
    let activeReference: ActiveWorkerCapture | undefined;
    const bargeIn =
      command.mode === 'autonomous'
        ? new NarrationBargeInMonitor({
            transcribe: (probe, signal) => {
              if (!activeReference) return Promise.reject(new Error('barge_in_capture_unavailable'));
              return this.transcribeBargeInProbe(activeReference, probe, signal);
            },
            onEvidence: (playbackGeneration, decision) => {
              if (activeReference)
                this.publishBargeInEvidence(activeReference, playbackGeneration, decision.evidence, publish);
            },
          })
        : undefined;
    const session = new CaptureSession({
      recorder: this.recorder,
      config,
      spool,
      clock: this.clock,
      onFrame: (frame) => {
        if (activeReference) this.observeFrame(activeReference, frame, publish);
      },
      capture: {
        mode: command.mode,
        activityControl: command.mode === 'autonomous' ? 'client' : 'host',
        ...(command.mode === 'autonomous' ? { endpointSilenceMs: command.utteranceIdleMs } : {}),
      },
      onClientActivity: (activity, captureGeneration) => {
        if (activeReference) this.observeClientActivity(activeReference, activity, captureGeneration, publish);
      },
      shouldPersistPcm: () =>
        !this.isPlaybackSuppressed(command.sessionId) || activeReference?.bargeIn?.confirmed === true,
      onRecoveryExhausted: (_error, captureGeneration) => {
        const current = activeReference;
        if (
          !current ||
          this.active !== current ||
          current.spool.snapshotManifest().captureGeneration !== captureGeneration
        )
          return;
        current.finalized = true;
        current.endpoint.cancel();
        current.bargeIn?.stop();
        publish({
          kind: 'failure',
          code: 'recorder_recovery_exhausted',
          recoverable: false,
          sessionId: command.sessionId,
          captureId: command.captureId,
          turnId: command.turnId,
        });
      },
      onStateChange: (state) => {
        if (state === 'starting' || state === 'recovering')
          publish({
            kind: 'capture-state',
            sessionId: command.sessionId,
            captureId: command.captureId,
            state: 'starting',
          });
      },
    });
    const active: ActiveWorkerCapture = {
      command,
      config,
      selected,
      spool,
      session,
      transcriptionAbort: new AbortController(),
      ...(command.mode === 'autonomous'
        ? {
            vad: this.createVad(command.sessionId),
            ...(speechDetector ? { speechDetector } : {}),
            bargeIn,
          }
        : {}),
      endpoint: new AutonomousEndpoint(this.clock, (speechGeneration) => {
        if (activeReference) this.requestEndpoint(activeReference, publish, speechGeneration);
      }),
      endpointReported: false,
      clientActivityElapsedMs: -1,
      clientActivityEpoch: -1,
      clientActivityGeneration: 0,
      clientActivityObserved: false,
      clientActivitySpeechMs: 0,
      clientActivityEchoDiscriminatedSpeechMs: 0,
      clientClassifierSpeechMs: 0,
      clientEchoDiscriminatedSpeechMs: 0,
      hostClassifierSpeechMs: 0,
      bargeInClientClassifierBaselineMs: 0,
      bargeInEchoDiscriminatedBaselineMs: 0,
      bargeInHostClassifierBaselineMs: 0,
      bargeInEchoDiscriminationAvailable: false,
      playbackOverlapMs: 0,
      clientSpeechStarted: false,
      finalized: false,
      startedAt: this.clock.now(),
      nextActivityAt: this.clock.now(),
    };
    activeReference = active;
    this.active = active;
    if (frozenSnapshot) {
      active.finalized = true;
      publish({
        kind: 'drained',
        sessionId: command.sessionId,
        captureId: command.captureId,
        turnId: command.turnId,
        revision: frozenSnapshot.revision,
      });
      publish({
        kind: 'capture-state',
        sessionId: command.sessionId,
        captureId: command.captureId,
        state: 'processing',
      });
      await this.processSnapshot(active, frozenSnapshot, publish);
      return;
    }
    const playbackReference = this.activePlaybackReference;
    if (bargeIn && playbackReference?.active && playbackReference.referenceText) {
      bargeIn.begin(
        {
          generation: playbackReference.playbackGeneration,
          text: playbackReference.referenceText,
          startPhrases: playbackReference.startPhrases ?? [],
          stopPhrases: playbackReference.stopPhrases ?? [],
        },
        this.clock.now(),
      );
    }
    try {
      await session.start();
    } catch (error) {
      spool.remove();
      this.active = undefined;
      throw error;
    }
    publish({
      kind: 'capture-state',
      sessionId: command.sessionId,
      captureId: command.captureId,
      state: 'listening',
    });
    active.limitTimer = this.clock.setTimeout(() => {
      if (this.active !== active || active.finalized) return;
      if (command.mode === 'autonomous') {
        publish({
          kind: 'failure',
          code: 'capture_duration_limit',
          recoverable: true,
          sessionId: command.sessionId,
          captureId: command.captureId,
          turnId: command.turnId,
        });
        return;
      }
      void this.handle(
        {
          version: command.version,
          sequence: command.sequence,
          kind: 'finalize-capture',
          sessionId: command.sessionId,
          captureId: command.captureId,
          reason: 'duration-limit',
        },
        publish,
      );
    }, command.maxDurationMs);
  }

  private async finalize(
    command: Extract<VoiceWorkerCommand, { kind: 'finalize-capture' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> {
    const active = this.active;
    if (!active || !matchesCapture(active, command) || active.finalized) return;
    if (
      command.reason === 'soft-endpoint' &&
      (!active.endpointReported || active.endpointGeneration !== active.endpoint.speechGeneration)
    )
      return;
    active.finalized = true;
    if (active.limitTimer) this.clock.clear(active.limitTimer);
    active.endpoint.cancel();
    active.bargeIn?.stop();
    publish({
      kind: 'capture-state',
      sessionId: command.sessionId,
      captureId: command.captureId,
      state: 'draining',
    });
    const snapshot = await active.session.drain();
    publish({
      kind: 'drained',
      sessionId: command.sessionId,
      captureId: command.captureId,
      turnId: active.command.turnId,
      revision: snapshot.revision,
    });
    publish({
      kind: 'capture-state',
      sessionId: command.sessionId,
      captureId: command.captureId,
      state: 'processing',
    });
    await this.processSnapshot(active, snapshot, publish);
  }

  private async processSnapshot(
    active: ActiveWorkerCapture,
    snapshot: { revision: number; wavPath: string },
    publish: VoiceWorkerPublish,
  ): Promise<void> {
    if (this.active !== active || active.transcriptionAbort.signal.aborted) return;
    const transcription = await this.transcribe(active, snapshot.wavPath, snapshot.revision);
    const { outcome } = transcription;
    if (this.active !== active || active.transcriptionAbort.signal.aborted) return;
    if (outcome.kind === 'success') {
      publish({
        kind: 'transcript-candidate',
        sessionId: active.command.sessionId,
        captureId: active.command.captureId,
        turnId: active.command.turnId,
        revision: snapshot.revision,
        transcript: outcome.transcript,
        final: true,
        evidence: transcription.evidence,
      });
      return;
    }
    publish({
      kind: 'failure',
      code:
        outcome.kind === 'empty'
          ? 'empty_transcript'
          : outcome.kind === 'timeout'
            ? 'transcription_timed_out'
            : outcome.code,
      recoverable: outcome.kind === 'empty',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      turnId: active.command.turnId,
      revision: snapshot.revision,
    });
  }

  private observeFrame(active: ActiveWorkerCapture, frame: Buffer, publish: VoiceWorkerPublish): void {
    if (this.isPlaybackSuppressed(active.command.sessionId)) {
      if (active.bargeIn?.confirmed) {
        if (active.clientActivityState === undefined)
          this.observeAutonomousFrame(active, frame, publish, {
            playbackOverlapMs: PCM_FRAME_MS,
            narrationHandoff: true,
          });
      } else {
        if (active.clientActivityState === undefined) {
          const speechDetected = this.detectSpeech(active, frame);
          if (speechDetected === true) active.hostClassifierSpeechMs += PCM_FRAME_MS;
        }
        const ordinaryClassifierSpeechMs = Math.max(
          0,
          active.clientClassifierSpeechMs - active.bargeInClientClassifierBaselineMs,
          active.hostClassifierSpeechMs - active.bargeInHostClassifierBaselineMs,
        );
        const trustedClassifierSpeechMs = active.bargeInEchoDiscriminationAvailable
          ? Math.max(0, active.clientEchoDiscriminatedSpeechMs - active.bargeInEchoDiscriminatedBaselineMs)
          : undefined;
        active.bargeIn?.observe(
          frame,
          this.clock.now(),
          active.vad?.noiseProfile,
          ordinaryClassifierSpeechMs,
          trustedClassifierSpeechMs !== undefined && trustedClassifierSpeechMs >= 300,
        );
      }
      return;
    }
    active.bargeIn?.reopenCleanLane();
    if (active.clientActivityState === undefined) this.observeAutonomousFrame(active, frame, publish);
    const now = this.clock.now();
    if (now < active.nextActivityAt) return;
    active.nextActivityAt = now + this.activityIntervalMs;
    const measuredDbfs = calculatePcmFrameDbfs(frame);
    const levelDbfs = Number.isFinite(measuredDbfs) ? measuredDbfs : -120;
    publish({
      kind: 'activity',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      state:
        active.clientActivityState === 'speech'
          ? 'speech'
          : active.clientActivityState === undefined && active.vad?.hasPendingSpeech
            ? 'speech'
            : 'listening',
      elapsedMs: Math.max(0, now - active.startedAt),
      levelDbfs,
      speechProbability: Math.max(0, Math.min(1, (levelDbfs + 60) / 35)),
    });
  }

  private observeClientActivity(
    active: ActiveWorkerCapture,
    activity: VoiceMediaCaptureActivity,
    captureGeneration: number,
    publish: VoiceWorkerPublish,
  ): void {
    if (active.command.mode !== 'autonomous' || active.finalized) return;
    if (captureGeneration !== active.clientActivityGeneration) {
      this.invalidateEndpoint(active);
      active.clientActivityGeneration = captureGeneration;
      active.clientActivityElapsedMs = -1;
      active.clientActivityEpoch = -1;
      active.clientActivityState = undefined;
      active.clientActivityObserved = false;
      active.clientActivitySpeechMs = 0;
      active.clientActivityEchoDiscriminatedSpeechMs = 0;
      active.clientEchoDiscriminatedSpeechMs = 0;
      active.bargeInEchoDiscriminatedBaselineMs = 0;
      active.bargeInEchoDiscriminationAvailable = false;
      active.clientSpeechStarted = false;
    }
    const activityEpoch = activity.epoch ?? 0;
    if (activityEpoch < active.clientActivityEpoch) return;
    if (activityEpoch > active.clientActivityEpoch) {
      this.invalidateEndpoint(active);
      active.clientActivityEpoch = activityEpoch;
      active.clientActivityElapsedMs = -1;
      active.clientActivityState = undefined;
      active.clientActivitySpeechMs = 0;
      active.clientActivityEchoDiscriminatedSpeechMs = 0;
      active.clientEchoDiscriminatedSpeechMs = 0;
      active.bargeInEchoDiscriminatedBaselineMs = 0;
      active.bargeInEchoDiscriminationAvailable = false;
      if (!active.bargeIn?.confirmed) active.clientSpeechStarted = false;
    }
    if (
      activity.elapsedMs < active.clientActivityElapsedMs ||
      (active.clientActivityState !== undefined &&
        clientActivityOrder(activity.state) < clientActivityOrder(active.clientActivityState))
    )
      return;
    const previousElapsedMs = active.clientActivityElapsedMs;
    const previousSpeechMs = active.clientActivitySpeechMs;
    const previousEchoDiscriminatedSpeechMs = active.clientActivityEchoDiscriminatedSpeechMs;
    active.clientActivityElapsedMs = activity.elapsedMs;
    active.clientActivityState = activity.state;
    active.clientActivityObserved = true;
    const epochSpeechMs =
      activity.classifiedSpeechMs ??
      (activity.state === 'speech'
        ? previousSpeechMs +
          (previousElapsedMs < 0 ? 120 : Math.max(PCM_FRAME_MS, activity.elapsedMs - previousElapsedMs))
        : previousSpeechMs);
    if (epochSpeechMs >= previousSpeechMs) {
      active.clientClassifierSpeechMs += epochSpeechMs - previousSpeechMs;
      active.clientActivitySpeechMs = epochSpeechMs;
    }
    const epochEchoDiscriminatedSpeechMs = activity.echoDiscriminatedSpeechMs;
    if (
      epochEchoDiscriminatedSpeechMs !== undefined &&
      epochEchoDiscriminatedSpeechMs >= previousEchoDiscriminatedSpeechMs
    ) {
      active.clientEchoDiscriminatedSpeechMs += epochEchoDiscriminatedSpeechMs - previousEchoDiscriminatedSpeechMs;
      active.clientActivityEchoDiscriminatedSpeechMs = epochEchoDiscriminatedSpeechMs;
      if (this.isPlaybackSuppressed(active.command.sessionId) && !active.bargeIn?.confirmed)
        active.bargeInEchoDiscriminationAvailable = true;
    }
    publish({
      kind: 'activity',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      state: activity.state === 'speech' ? 'speech' : 'listening',
      elapsedMs: activity.elapsedMs,
      levelDbfs: activity.levelDbfs,
      speechProbability: Math.max(0, Math.min(1, (activity.levelDbfs + 60) / 35)),
    });
    if (this.isPlaybackSuppressed(active.command.sessionId) && !active.bargeIn?.confirmed) return;
    if (activity.state === 'speech') {
      if (active.clientSpeechStarted) return;
      active.clientSpeechStarted = true;
      const manifest = active.spool.snapshotManifest();
      if (manifest.utteranceStartByte === undefined)
        active.spool.markUtteranceStart(Math.max(0, manifest.committedBytes - AUTONOMOUS_PRE_ROLL_BYTES));
      this.startSpeechGeneration(active);
      publish({
        kind: 'capture-state',
        sessionId: active.command.sessionId,
        captureId: active.command.captureId,
        state: 'speech',
      });
      return;
    }
    if (activity.state !== 'endpoint' || !active.clientSpeechStarted || active.endpointReported) return;
    this.requestEndpoint(active, publish);
  }

  private observeAutonomousFrame(
    active: ActiveWorkerCapture,
    frame: Buffer,
    publish: VoiceWorkerPublish,
    metadata: { playbackOverlapMs?: number; narrationHandoff?: boolean } = {},
    persistedFrameEndByte = active.spool.snapshotManifest().committedBytes,
  ): void {
    if (!active.vad) return;
    const speechDetected = this.detectSpeech(active, frame);
    if (speechDetected === true) active.hostClassifierSpeechMs += PCM_FRAME_MS;
    const result = active.vad.push(frame, {
      ...metadata,
      ...(speechDetected === undefined ? {} : { speechDetected }),
    });
    this.rememberNoiseProfile(active.command.sessionId, active.vad.noiseProfile);
    if (result.speechStarted) {
      const manifest = active.spool.snapshotManifest();
      if (manifest.utteranceStartByte === undefined)
        active.spool.markUtteranceStart(Math.max(0, persistedFrameEndByte - AUTONOMOUS_PRE_ROLL_BYTES));
      this.startSpeechGeneration(active);
      publish({
        kind: 'capture-state',
        sessionId: active.command.sessionId,
        captureId: active.command.captureId,
        state: 'speech',
      });
    }
    if (!result.segment) return;
    publish({
      kind: 'capture-state',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      state: 'listening',
    });
    active.endpoint.speechEnded(active.command.utteranceIdleMs, {
      segmentClosed: true,
      forcedClose: result.segment.activityHistogram.forcedClose,
      trailingSilenceMs: result.segment.activityHistogram.trailingSilenceMs,
    });
  }

  private startSpeechGeneration(active: ActiveWorkerCapture): number {
    const speechGeneration = active.endpoint.speechStarted();
    active.endpointReported = false;
    delete active.endpointGeneration;
    return speechGeneration;
  }

  private invalidateEndpoint(active: ActiveWorkerCapture): void {
    active.endpoint.invalidate();
    active.endpointReported = false;
    delete active.endpointGeneration;
  }

  private requestEndpoint(
    active: ActiveWorkerCapture,
    publish: VoiceWorkerPublish,
    speechGeneration = active.endpoint.speechGeneration,
  ): void {
    if (
      this.active !== active ||
      active.command.mode !== 'autonomous' ||
      active.endpointReported ||
      speechGeneration !== active.endpoint.speechGeneration
    )
      return;
    active.endpointReported = true;
    active.endpointGeneration = speechGeneration;
    publish({
      kind: 'endpoint-reached',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      turnId: active.command.turnId,
    });
  }

  private async transcribe(
    active: ActiveWorkerCapture,
    audioPath: string,
    revision: number,
  ): Promise<{ outcome: TurnTranscriptionOutcome; evidence: VoiceTranscriptSignalEvidence }> {
    const manifest = active.spool.snapshotManifest();
    const pcm = active.spool.readCommittedPcm().subarray(manifest.utteranceStartByte ?? 0);
    const summary = analyzePcm16(pcm);
    const classifierSpeechMs = Math.max(active.clientClassifierSpeechMs, active.hostClassifierSpeechMs);
    const baseEvidence: VoiceTranscriptSignalEvidence = {
      durationMs: summary.durationMs,
      voicedMs: summary.voicedMs,
      classifierSpeechMs,
      rmsDbfs: summary.rmsDbfs,
      peakDbfs: summary.peakDbfs,
      signalVariationDb: summary.signalVariationDb,
      nonZeroRatio: summary.nonZeroRatio,
      gapCount: manifest.gapCount,
      playbackOverlapMs: active.playbackOverlapMs,
      classifier: active.clientActivityObserved ? 'client' : active.speechDetector ? 'host' : 'energy',
    };
    if (active.command.mode === 'autonomous' && isDeterministicNoSpeech(summary, classifierSpeechMs))
      return { outcome: { kind: 'empty' }, evidence: baseEvidence };

    const transcribePath = (targetPath: string, signal: AbortSignal): Promise<TranscriptionAdapterOutput> =>
      active.selected.adapter.transcribe({
        audioPath: targetPath,
        workspace: active.spool.directory,
        config: active.selected.config,
        language: active.config.language,
        signal,
      });
    const outcome = await this.turnTranscriber.transcribe({
      signal: active.transcriptionAbort.signal,
      timeoutMs: active.command.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
      transcribe: (signal) => transcribePath(audioPath, signal),
      ...(summary.nonZeroSamples === 0
        ? {}
        : {
            retryNormalized: (signal: AbortSignal) => {
              const normalizedPath = path.join(active.spool.directory, `normalized-${revision}.wav`);
              writePrivatePcm16Wav(normalizedPath, normalizePcm16(pcm));
              return transcribePath(normalizedPath, signal);
            },
          }),
    });
    return {
      outcome,
      evidence: {
        ...baseEvidence,
        ...(outcome.kind === 'success' && outcome.evidence ? { asr: outcome.evidence } : {}),
      },
    };
  }

  private pruneAcknowledgedSpools(sessionId: string, currentTurnId: string): void {
    for (const [key, spool] of this.recovered) {
      const manifest = spool.snapshotManifest();
      if (
        manifest.sessionId === sessionId &&
        manifest.turnId !== currentTurnId &&
        manifest.acknowledgedRevision !== undefined
      ) {
        spool.remove();
        this.recovered.delete(key);
      }
    }
  }

  private recoverSpools(rootDirectory: string, publish: VoiceWorkerPublish): void {
    this.recovered.clear();
    if (!fs.existsSync(rootDirectory)) return;
    let recoveryFailureCount = 0;
    for (const entry of fs.readdirSync(rootDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('turn-')) continue;
      const spool = recoverTurnSpool(path.join(rootDirectory, entry.name));
      if (!spool) {
        recoveryFailureCount += 1;
        continue;
      }
      const manifest = spool.snapshotManifest();
      this.recovered.set(spoolKey(manifest), spool);
      if (manifest.acknowledgedRevision !== undefined && manifest.acknowledgedOutcome !== undefined) {
        publish({
          kind: 'candidate-acknowledged',
          sessionId: manifest.sessionId,
          captureId: manifest.captureId,
          turnId: manifest.turnId,
          revision: manifest.acknowledgedRevision,
          outcome: manifest.acknowledgedOutcome,
        });
        continue;
      }
      publish({
        kind: 'recovered',
        sessionId: manifest.sessionId,
        turnId: manifest.turnId,
        revision: manifest.revision,
        gapCount: manifest.gapCount,
      });
    }
    if (recoveryFailureCount > 0) {
      publish({ kind: 'failure', code: 'spool_recovery_failed', recoverable: true });
    }
  }

  private createVad(sessionId: string): AdaptiveVoiceActivityDetector {
    return new AdaptiveVoiceActivityDetector(undefined, this.sessionNoiseProfiles.get(sessionId));
  }

  private ensureSpeechDetector(): ISpeechPresenceDetector | undefined {
    if (this.speechDetectorUnavailable) return undefined;
    try {
      this.speechDetector ??= this.speechDetectorFactory();
      return this.speechDetector;
    } catch {
      this.markSpeechDetectorUnavailable();
      return undefined;
    }
  }

  private prepareSpeechDetector(): ISpeechPresenceDetector | undefined {
    const detector = this.ensureSpeechDetector();
    if (!detector) return undefined;
    try {
      detector.reset();
      return detector;
    } catch {
      this.markSpeechDetectorUnavailable();
      return undefined;
    }
  }

  private detectSpeech(active: ActiveWorkerCapture, frame: Buffer): boolean | undefined {
    if (!active.speechDetector) return undefined;
    try {
      return active.speechDetector.push(frame);
    } catch {
      this.disableSpeechDetector(active);
      return undefined;
    }
  }

  private resetVoiceActivity(active: ActiveWorkerCapture): void {
    active.vad?.reset();
    try {
      active.speechDetector?.reset();
    } catch {
      this.disableSpeechDetector(active);
    }
  }

  private disableSpeechDetector(active: ActiveWorkerCapture): void {
    delete active.speechDetector;
    this.markSpeechDetectorUnavailable();
  }

  private markSpeechDetectorUnavailable(): void {
    this.speechDetector = undefined;
    this.speechDetectorUnavailable = true;
  }

  private rememberNoiseProfile(sessionId: string, profile: VadNoiseProfile): void {
    this.sessionNoiseProfiles.delete(sessionId);
    this.sessionNoiseProfiles.set(sessionId, profile);
    while (this.sessionNoiseProfiles.size > MAX_SESSION_NOISE_PROFILES) {
      const oldestSessionId = this.sessionNoiseProfiles.keys().next().value;
      if (oldestSessionId === undefined) return;
      this.sessionNoiseProfiles.delete(oldestSessionId);
    }
  }

  private publishBargeInEvidence(
    active: ActiveWorkerCapture,
    playbackGeneration: number,
    evidence: NarrationBargeInEvidence,
    publish: VoiceWorkerPublish,
  ): void {
    if (
      this.active !== active ||
      active.finalized ||
      this.activePlaybackReference?.playbackGeneration !== playbackGeneration
    )
      return;
    publish({
      kind: 'barge-in-evidence',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      turnId: active.command.turnId,
      playbackGeneration,
      evidence,
    });
  }

  private promoteBargeIn(
    command: Extract<VoiceWorkerCommand, { kind: 'confirm-barge-in' }>,
    publish: VoiceWorkerPublish,
  ): void {
    const active = this.active;
    if (
      !active?.vad ||
      !matchesCapture(active, command) ||
      active.command.turnId !== command.turnId ||
      active.finalized
    )
      return;
    if (command.outcome === 'discard') {
      active.bargeIn?.discard(command.playbackGeneration);
      return;
    }
    const pcm = active.bargeIn?.promote(command.playbackGeneration);
    if (!pcm || pcm.length === 0) return;
    const committedBeforePromotion = active.spool.snapshotManifest().committedBytes;
    active.playbackOverlapMs += (pcm.length / PCM_FRAME_BYTES) * PCM_FRAME_MS;
    active.spool.append(pcm);
    this.resetVoiceActivity(active);
    if (active.clientActivityObserved) {
      const manifest = active.spool.snapshotManifest();
      if (manifest.utteranceStartByte === undefined) active.spool.markUtteranceStart(committedBeforePromotion);
      active.clientSpeechStarted = true;
      this.startSpeechGeneration(active);
      publish({
        kind: 'capture-state',
        sessionId: active.command.sessionId,
        captureId: active.command.captureId,
        state: 'speech',
      });
      if (active.clientActivityState === 'endpoint') this.requestEndpoint(active, publish);
      return;
    }
    active.hostClassifierSpeechMs = 0;
    for (let offset = 0; offset + PCM_FRAME_BYTES <= pcm.length; offset += PCM_FRAME_BYTES) {
      this.observeAutonomousFrame(
        active,
        pcm.subarray(offset, offset + PCM_FRAME_BYTES),
        publish,
        {
          playbackOverlapMs: PCM_FRAME_MS,
          narrationHandoff: true,
        },
        committedBeforePromotion + offset + PCM_FRAME_BYTES,
      );
    }
  }

  private async transcribeBargeInProbe(
    active: ActiveWorkerCapture,
    probe: NarrationBargeInProbe,
    signal: AbortSignal,
  ): Promise<string> {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-voice-barge-in-'));
    fs.chmodSync(workspace, 0o700);
    try {
      const audioPath = path.join(workspace, `probe-${probe.generation}-${probe.revision}.wav`);
      writePrivatePcm16Wav(audioPath, probe.pcm);
      const outcome = await this.turnTranscriber.transcribe({
        signal,
        timeoutMs: Math.min(
          active.command.transcriptionTimeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
          BARGE_IN_PROBE_TIMEOUT_MS,
        ),
        transcribe: (ownedSignal) =>
          active.selected.adapter.transcribe({
            audioPath,
            workspace,
            config: active.selected.config,
            language: active.config.language,
            signal: ownedSignal,
          }),
      });
      return outcome.kind === 'success' ? outcome.transcript : '';
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  private updatePlaybackGate(command: Extract<VoiceWorkerCommand, { kind: 'playback-state' }>): void {
    const now = this.clock.now();
    const changed = this.playbackGate.update(command, now);
    if (!changed) return;
    this.activePlaybackReference = command.active ? { ...command } : undefined;
    const active = this.active;
    if (!active?.vad || active.command.sessionId !== command.sessionId) return;
    if (command.active) {
      active.bargeInClientClassifierBaselineMs = active.clientClassifierSpeechMs;
      active.bargeInEchoDiscriminatedBaselineMs = active.clientEchoDiscriminatedSpeechMs;
      active.bargeInHostClassifierBaselineMs = active.hostClassifierSpeechMs;
      active.bargeInEchoDiscriminationAvailable = false;
      this.resetVoiceActivity(active);
      this.invalidateEndpoint(active);
      if (command.referenceText)
        active.bargeIn?.begin(
          {
            generation: command.playbackGeneration,
            text: command.referenceText,
            startPhrases: command.startPhrases ?? [],
            stopPhrases: command.stopPhrases ?? [],
          },
          now,
        );
      else active.bargeIn?.stop();
      return;
    }
    active.bargeIn?.finish(command.playbackGeneration);
    if (active.bargeIn?.confirmed) return;
    this.resetVoiceActivity(active);
    this.invalidateEndpoint(active);
  }

  private isPlaybackSuppressed(sessionId: string): boolean {
    return this.playbackGate.suppresses(sessionId, this.clock.now());
  }

  private async cancelActive(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    if (active.limitTimer) this.clock.clear(active.limitTimer);
    active.endpoint.cancel();
    active.bargeIn?.stop();
    active.transcriptionAbort.abort();
    await active.session.abort();
    active.spool.remove();
  }
}
