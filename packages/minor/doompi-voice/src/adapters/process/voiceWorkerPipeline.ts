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
import { normalizePcm16, summarizePcm16 } from '../../services/transcriptionCoordinator.ts';
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
} from '../../types/index.ts';
import {
  ExecutableResolver,
  FfmpegPcmAudioRecorder,
  NodeBinaryProcessSpawner,
  NodeProcessSpawner,
  SystemClock,
  writePrivatePcm16Wav,
} from '../audio/infrastructure.ts';
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
    this.recorder =
      dependencies.recorder ?? new FfmpegPcmAudioRecorder(executables, new NodeBinaryProcessSpawner(), this.clock);
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
    const operation = this.operations.then(() => this.handleOrdered(command, publish));
    this.operations = operation.catch(() => undefined);
    return operation;
  }

  public async shutdown(): Promise<void> {
    await this.cancelActive();
  }

  private async handleOrdered(
    command: Exclude<VoiceWorkerCommand, { kind: 'initialize' | 'shutdown' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> {
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
        if (this.active && matchesCapture(this.active, command)) {
          const { command: activeCommand, spool } = this.active;
          spool.acknowledge(command.revision, command.outcome);
          spool.remove();
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
        recovered.remove();
        this.recovered.delete(spoolKey(command));
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
    const recoveredKey = spoolKey(command);
    const recovered = this.recovered.get(recoveredKey);
    if (recovered && recovered.snapshotManifest().captureId !== command.captureId)
      throw new Error('recovered_capture_identity_mismatch');
    const spool =
      recovered ??
      NodeTurnSpool.create(this.spoolDirectory, {
        sessionId: command.sessionId,
        captureId: command.captureId,
        turnId: command.turnId,
      });
    if (recovered) {
      this.recovered.delete(recoveredKey);
      spool.recordGap();
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
      shouldPersistPcm: () =>
        !this.isPlaybackSuppressed(command.sessionId) || activeReference?.bargeIn?.confirmed === true,
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
      endpoint: new AutonomousEndpoint(this.clock, () => {
        if (activeReference) this.requestEndpoint(activeReference, publish);
      }),
      endpointReported: false,
      finalized: false,
      startedAt: this.clock.now(),
      nextActivityAt: this.clock.now(),
    };
    activeReference = active;
    this.active = active;
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
    const outcome = await this.transcribe(active, snapshot.wavPath, snapshot.revision);
    if (outcome.kind === 'success') {
      publish({
        kind: 'transcript-candidate',
        sessionId: command.sessionId,
        captureId: command.captureId,
        turnId: active.command.turnId,
        revision: snapshot.revision,
        transcript: outcome.transcript,
        final: true,
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
      sessionId: command.sessionId,
      captureId: command.captureId,
      turnId: active.command.turnId,
      revision: snapshot.revision,
    });
  }

  private observeFrame(active: ActiveWorkerCapture, frame: Buffer, publish: VoiceWorkerPublish): void {
    if (this.isPlaybackSuppressed(active.command.sessionId)) {
      if (active.bargeIn?.confirmed) {
        this.observeAutonomousFrame(active, frame, publish, {
          playbackOverlapMs: PCM_FRAME_MS,
          narrationHandoff: true,
        });
      } else {
        active.bargeIn?.observe(frame, this.clock.now(), active.vad?.noiseProfile);
      }
      return;
    }
    active.bargeIn?.reopenCleanLane();
    this.observeAutonomousFrame(active, frame, publish);
    const now = this.clock.now();
    if (now < active.nextActivityAt) return;
    active.nextActivityAt = now + this.activityIntervalMs;
    const measuredDbfs = calculatePcmFrameDbfs(frame);
    const levelDbfs = Number.isFinite(measuredDbfs) ? measuredDbfs : -120;
    publish({
      kind: 'activity',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      state: active.vad?.hasPendingSpeech ? 'speech' : 'listening',
      elapsedMs: Math.max(0, now - active.startedAt),
      levelDbfs,
      speechProbability: Math.max(0, Math.min(1, (levelDbfs + 60) / 35)),
    });
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
    const result = active.vad.push(frame, {
      ...metadata,
      ...(speechDetected === undefined ? {} : { speechDetected }),
    });
    this.rememberNoiseProfile(active.command.sessionId, active.vad.noiseProfile);
    if (result.speechStarted) {
      const manifest = active.spool.snapshotManifest();
      if (manifest.utteranceStartByte === undefined)
        active.spool.markUtteranceStart(Math.max(0, persistedFrameEndByte - AUTONOMOUS_PRE_ROLL_BYTES));
      active.endpoint.speechStarted();
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

  private requestEndpoint(active: ActiveWorkerCapture, publish: VoiceWorkerPublish): void {
    if (this.active !== active || active.command.mode !== 'autonomous' || active.endpointReported) return;
    active.endpointReported = true;
    publish({
      kind: 'endpoint-reached',
      sessionId: active.command.sessionId,
      captureId: active.command.captureId,
      turnId: active.command.turnId,
    });
  }

  private transcribe(
    active: ActiveWorkerCapture,
    audioPath: string,
    revision: number,
  ): Promise<TurnTranscriptionOutcome> {
    const manifest = active.spool.snapshotManifest();
    const pcm = active.spool.readCommittedPcm().subarray(manifest.utteranceStartByte ?? 0);
    const summary = summarizePcm16(pcm);
    const transcribePath = (targetPath: string, signal: AbortSignal): Promise<string> =>
      active.selected.adapter.transcribe({
        audioPath: targetPath,
        workspace: active.spool.directory,
        config: active.selected.config,
        language: active.config.language,
        signal,
      });
    return this.turnTranscriber.transcribe({
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
      if (manifest.acknowledgedRevision !== undefined) {
        spool.remove();
        continue;
      }
      this.recovered.set(spoolKey(manifest), spool);
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
    active.spool.append(pcm);
    this.resetVoiceActivity(active);
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
      this.resetVoiceActivity(active);
      active.endpoint.invalidate();
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
    active.endpoint.invalidate();
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
    if (!active.finalized) active.spool.remove();
  }
}
