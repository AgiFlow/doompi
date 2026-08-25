import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { type ActorRefFrom, createActor, waitFor } from 'xstate';
import type { AutoCaptureActivationState, AutoCaptureUi, IClock } from '../types/index.ts';
import { AutonomousTurnIdentityFactory, type AutonomousTurnNonceFactory } from './autonomousTurn.ts';
import {
  type AutonomousTurnIdentity,
  type AutonomousVoiceEffect,
  type AutonomousVoiceSnapshot,
  autonomousVoiceMachine,
} from './autonomousVoiceMachine.ts';
import { AutonomousVoiceTelemetry } from './autonomousVoiceTelemetry.ts';
import { projectAutonomousVoiceUi } from './autonomousVoiceUi.ts';
import { applyTranscriptPolicy } from './transcriptPolicy.ts';
import { VoiceDelivery, type VoiceDeliveryIntent, type VoiceDeliveryResult } from './voiceDelivery.ts';
import type {
  VoiceCandidateOutcome,
  VoiceFinalizeReason,
  VoiceWorkerCaptureConfiguration,
  VoiceWorkerEvent,
} from './voiceWorkerProtocol.ts';

const MAX_CAPTURE_DURATION_MS = 300_000;
const MAX_COMPOSITION_CHARACTERS = 32_768;
const WORKER_FINALIZE_REASON = {
  endpoint: 'soft-endpoint',
  'duration-limit': 'duration-limit',
  'toggle-off': 'auto-disabled',
} as const satisfies Record<'endpoint' | 'duration-limit' | 'toggle-off', VoiceFinalizeReason>;
const SESSION_STOP_WAIT_MS = 21_000;
const SESSION_SHUTDOWN_REASON = 'session-shutdown';

const CLEANUP_OPERATION_LABELS = {
  playback_abort: 'playback abort',
  capture_cancel: 'capture cancellation',
  worker_shutdown: 'worker shutdown',
} as const;

type CleanupOperation = keyof typeof CLEANUP_OPERATION_LABELS;

export interface AutonomousCaptureInput extends AutonomousTurnIdentity {
  mode: 'autonomous';
  config: VoiceWorkerCaptureConfiguration;
  maxDurationMs: number;
  utteranceIdleMs: number;
  transcriptionTimeoutMs?: number;
}

export interface AutonomousVoiceWorkerPort {
  start(): Promise<void>;
  beginCapture(input: AutonomousCaptureInput): void;
  finalizeCapture(sessionId: string, captureId: string, reason: VoiceFinalizeReason): void;
  cancelCapture(sessionId: string, captureId: string): void;
  acknowledgeCandidate(sessionId: string, turnId: string, revision: number, outcome: VoiceCandidateOutcome): void;
  setPlaybackState?(
    sessionId: string,
    playbackGeneration: number,
    active: boolean,
    reference?: { text: string; startPhrases: readonly string[]; stopPhrases: readonly string[] },
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

export interface AutonomousVoiceSessionDependencies {
  config: ResolvedVoiceConfig;
  client: AutonomousVoiceWorkerPort;
  clock: IClock;
  ui: AutoCaptureUi;
  deliver(this: void, text: string, intent?: VoiceDeliveryIntent): void;
  narrationReferences(): readonly string[];
  correctTranscript?(this: void, transcript: string, signal: AbortSignal): Promise<string>;
  abortPlayback(): Promise<void>;
  telemetry?: AutonomousVoiceTelemetry;
  onActivationStateChange(state: AutoCaptureActivationState): void;
  onStopped(): void;
  identityNonceFactory?: AutonomousTurnNonceFactory;
}

function workerConfiguration(config: ResolvedVoiceConfig): VoiceWorkerCaptureConfiguration {
  return {
    engine: config.engine,
    language: config.language,
    recorder: { ...config.recorder },
    adapters: { ...config.adapters },
  };
}

function activationState(snapshot: AutonomousVoiceSnapshot): AutoCaptureActivationState {
  if (snapshot.matches('off')) return 'disabled';
  if (snapshot.matches('enabling') || snapshot.matches({ active: { capture: 'startingCapture' } })) return 'starting';
  if (snapshot.matches('failed')) return 'shuttingDown';
  if (snapshot.matches('stopping') || snapshot.context.stopRequested) return 'draining';
  return 'active';
}

export class AutonomousVoiceSession {
  private readonly actor: ActorRefFrom<typeof autonomousVoiceMachine>;
  private readonly identities: AutonomousTurnIdentityFactory;
  private readonly sessionId: string;
  private readonly delivery: VoiceDelivery;
  private modalBlocked = false;
  private transcriptCorrectionAbort: AbortController | undefined;
  private playbackAbortInFlight: Promise<void> | undefined;
  private stopInFlight: Promise<void> | undefined;
  private hardStopStarted = false;
  private started = false;
  private lastActivationState: AutoCaptureActivationState = 'disabled';
  private compositionDraft: string[] = [];
  private pendingCompositionSubmission: (AutonomousTurnIdentity & { revision: number }) | undefined;

  public constructor(private readonly dependencies: AutonomousVoiceSessionDependencies) {
    this.identities = new AutonomousTurnIdentityFactory(dependencies.clock, dependencies.identityNonceFactory);
    this.sessionId = this.identities.createSession();
    this.actor = createActor(autonomousVoiceMachine, {
      clock: {
        setTimeout: (callback, milliseconds) => dependencies.clock.setTimeout(callback, milliseconds),
        clearTimeout: (handle) => dependencies.clock.clear(handle),
      },
    });
    this.delivery = new VoiceDelivery({
      deliver: dependencies.deliver,
      onResult: (result) => this.receiveDeliveryResult(result),
    });
    this.actor.on('*', (effect) => this.handleEffect(effect));
    this.actor.subscribe((snapshot) => this.publishSnapshot(snapshot));
  }

  public get snapshot(): AutonomousVoiceSnapshot {
    return this.actor.getSnapshot();
  }

  public get state(): AutoCaptureActivationState {
    return activationState(this.snapshot);
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.actor.start();
    this.actor.send({ type: 'ENABLE_REQUESTED', sessionId: this.sessionId });
    await waitFor(this.actor, (snapshot) => !snapshot.matches('enabling'), { timeout: SESSION_STOP_WAIT_MS });
    if (this.actor.getSnapshot().matches('failed') || this.actor.getSnapshot().matches('off'))
      throw new Error('Autonomous voice failed to start.');
  }

  public toggleOff(): void {
    if (!this.started) return;
    this.abortTranscriptCorrection();
    this.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });
  }

  public async shutdown(): Promise<void> {
    if (!this.started || this.actor.getSnapshot().matches('off')) return;
    this.abortTranscriptCorrection();
    this.actor.send({ type: 'HARD_STOP_REQUESTED' });
    await waitFor(this.actor, (snapshot) => snapshot.matches('off'), { timeout: SESSION_STOP_WAIT_MS });
  }

  public receive(event: VoiceWorkerEvent): void {
    const identity = this.currentIdentity();
    if (!identity) return;
    if ('sessionId' in event && event.sessionId !== identity.sessionId) return;
    if ('captureId' in event && event.captureId !== undefined && event.captureId !== identity.captureId) return;
    if (event.kind === 'capture-state') {
      if (event.state === 'listening') this.actor.send({ type: 'CAPTURE_READY', ...identity });
      else if (event.state === 'speech') this.actor.send({ type: 'SPEECH_CONFIRMED', ...identity });
      else if (event.state === 'processing') this.actor.send({ type: 'CAPTURE_PROCESSING', ...identity });
      return;
    }
    if (event.kind === 'endpoint-reached') {
      if (event.turnId === identity.turnId) this.actor.send({ type: 'ENDPOINT_REACHED', ...identity });
      return;
    }
    if (event.kind === 'drained') {
      if (event.turnId === identity.turnId && event.revision !== undefined)
        this.actor.send({ type: 'CAPTURE_DRAINED', ...identity, revision: event.revision });
      return;
    }
    if (event.kind === 'transcript-candidate') {
      if (!event.final || event.turnId !== identity.turnId) return;
      this.actor.send({
        type: 'TRANSCRIPTION_SUCCEEDED',
        ...identity,
        revision: event.revision,
        transcript: event.transcript,
      });
      return;
    }
    if (event.kind === 'candidate-acknowledged') {
      if (event.turnId === identity.turnId)
        this.actor.send({ type: 'CANDIDATE_ACKNOWLEDGED', ...identity, revision: event.revision });
      return;
    }
    if (event.kind === 'barge-in-evidence') {
      if (event.turnId === identity.turnId)
        this.actor.send({
          type: 'BARGE_IN_EVIDENCE',
          ...identity,
          playbackGeneration: event.playbackGeneration,
          evidence: event.evidence,
        });
      return;
    }
    if (event.kind === 'failure') {
      if (event.code === 'capture_duration_limit') {
        this.actor.send({ type: 'CAPTURE_DURATION_LIMIT_REACHED', ...identity });
        return;
      }
      if (event.code === 'empty_transcript' && event.revision !== undefined) {
        this.actor.send({ type: 'TRANSCRIPTION_EMPTY', ...identity, revision: event.revision });
        return;
      }
      if (event.code === 'transcription_timed_out') {
        this.actor.send({
          type: 'TRANSCRIPTION_TIMED_OUT',
          ...identity,
          ...(event.revision === undefined ? {} : { revision: event.revision }),
        });
        return;
      }
      if (this.snapshot.matches({ active: { capture: 'transcribing' } })) {
        this.actor.send({
          type: 'TRANSCRIPTION_FAILED',
          ...identity,
          ...(event.revision === undefined ? {} : { revision: event.revision }),
          code: event.code,
          recoverable: event.recoverable,
        });
        return;
      }
      this.actor.send({ type: 'WORKER_EXHAUSTED', code: event.code });
    }
  }

  public workerExhausted(code: string): void {
    if (!this.started) return;
    this.actor.send({ type: 'WORKER_EXHAUSTED', code });
  }

  public playbackStarted(playbackGeneration: number, referenceText?: string): void {
    if (!this.started) return;
    this.actor.send({
      type: 'PLAYBACK_STARTED',
      sessionId: this.sessionId,
      playbackGeneration,
      ...(referenceText ? { referenceText } : {}),
    });
  }

  public playbackEnded(playbackGeneration: number): void {
    if (!this.started) return;
    this.actor.send({ type: 'PLAYBACK_ENDED', sessionId: this.sessionId, playbackGeneration });
  }

  public setModalBlocked(blocked: boolean): void {
    this.modalBlocked = blocked;
    this.delivery.setBlocked(blocked);
    this.publishSnapshot(this.actor.getSnapshot());
  }

  private handleEffect(effect: AutonomousVoiceEffect): void {
    this.dependencies.telemetry?.recordEffect(effect);
    switch (effect.type) {
      case 'effect.enable':
        void this.enable(effect.sessionId);
        return;
      case 'effect.beginCapture':
        this.beginCapture(effect);
        return;
      case 'effect.cancelCapture':
        this.dependencies.client.cancelCapture(effect.sessionId, effect.captureId);
        return;
      case 'effect.finalizeCapture':
        this.dependencies.client.finalizeCapture(
          effect.sessionId,
          effect.captureId,
          WORKER_FINALIZE_REASON[effect.reason],
        );
        return;
      case 'effect.applyTranscriptPolicy':
        this.applyPolicy(effect);
        return;
      case 'effect.deliver':
        this.delivery.submit(effect);
        return;
      case 'effect.acknowledge':
        this.dependencies.client.acknowledgeCandidate(effect.sessionId, effect.turnId, effect.revision, effect.outcome);
        return;
      case 'effect.prepareNextTurn': {
        const next = this.identities.createTurn(effect.sessionId);
        this.actor.send({ type: 'NEXT_TURN_READY', ...next });
        return;
      }
      case 'effect.setPlaybackGate':
        this.dependencies.client.setPlaybackState?.(
          effect.sessionId,
          effect.playbackGeneration,
          effect.active,
          effect.active && effect.referenceText
            ? {
                text: effect.referenceText,
                startPhrases: this.dependencies.config.autoCapture?.startPhrases ?? [],
                stopPhrases: this.dependencies.config.autoCapture?.stopPhrases ?? [],
              }
            : undefined,
        );
        return;
      case 'effect.confirmBargeIn':
        this.dependencies.client.confirmBargeIn?.(
          effect.sessionId,
          effect.captureId,
          effect.turnId,
          effect.playbackGeneration,
          effect.outcome,
        );
        return;
      case 'effect.abortPlayback':
        this.requestPlaybackAbort();
        return;
      case 'effect.stop':
        void this.stop(effect.mode);
        return;
      case 'effect.reportFailure':
        this.dependencies.ui.notify(`Autonomous voice failed: ${effect.failure.code}`, 'error');
        return;
    }
  }

  private async enable(sessionId: string): Promise<void> {
    try {
      await this.dependencies.client.start();
      const snapshot = this.actor.getSnapshot();
      if (!snapshot.matches('enabling') || snapshot.context.sessionId !== sessionId) {
        try {
          await this.dependencies.client.shutdown(SESSION_SHUTDOWN_REASON);
        } catch (error) {
          this.reportCleanupFailure('worker_shutdown', error);
        }
        return;
      }
      this.actor.send({ type: 'ENABLE_SUCCEEDED', ...this.identities.createTurn(sessionId) });
    } catch (error) {
      this.actor.send({
        type: 'ENABLE_FAILED',
        sessionId,
        code: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private beginCapture(identity: AutonomousTurnIdentity): void {
    const autoConfig = this.dependencies.config.autoCapture;
    if (!autoConfig) {
      this.actor.send({
        type: 'CAPTURE_START_FAILED',
        ...identity,
        code: 'autonomous_voice_not_configured',
        recoverable: false,
      });
      return;
    }
    try {
      this.dependencies.client.beginCapture({
        sessionId: identity.sessionId,
        captureId: identity.captureId,
        turnId: identity.turnId,
        mode: 'autonomous',
        config: workerConfiguration(this.dependencies.config),
        maxDurationMs: MAX_CAPTURE_DURATION_MS,
        utteranceIdleMs: autoConfig.utteranceIdleMs,
        transcriptionTimeoutMs: autoConfig.transcriptionTimeoutMs,
      });
    } catch (error) {
      this.actor.send({
        type: 'CAPTURE_START_FAILED',
        ...identity,
        code: error instanceof Error ? error.message : String(error),
        recoverable: false,
      });
    }
  }

  private correctAndHandleTranscript(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    transcript: string,
    onAccepted: (transcript: string) => void,
  ): void {
    const correct = this.dependencies.correctTranscript;
    if (!correct) {
      onAccepted(transcript);
      return;
    }
    this.abortTranscriptCorrection();
    const abortController = new AbortController();
    this.transcriptCorrectionAbort = abortController;
    void Promise.resolve()
      .then(() => correct(transcript, abortController.signal))
      .then(
        (corrected) => this.finishTranscriptCorrection(abortController, effect, corrected, onAccepted),
        () => this.finishTranscriptCorrection(abortController, effect, transcript, onAccepted),
      );
  }

  private finishTranscriptCorrection(
    abortController: AbortController,
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    transcript: string,
    onAccepted: (transcript: string) => void,
  ): void {
    if (this.transcriptCorrectionAbort !== abortController) return;
    this.transcriptCorrectionAbort = undefined;
    const snapshot = this.snapshot;
    const context = snapshot.context;
    if (!snapshot.matches({ active: { capture: 'applyingPolicy' } })) return;
    if (
      context.sessionId !== effect.sessionId ||
      context.captureId !== effect.captureId ||
      context.turnId !== effect.turnId ||
      context.revision !== effect.revision
    )
      return;
    onAccepted(transcript);
  }

  private acceptTranscript(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    transcript: string,
  ): void {
    this.actor.send({
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
      text: transcript,
      type: 'TRANSCRIPT_ACCEPTED',
    });
  }

  private bufferCompositionSegment(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    operation: 'open' | 'append',
    transcript: string,
  ): void {
    if (operation === 'open') this.clearCompositionDraft();
    const candidate = [...this.compositionDraft, ...(transcript ? [transcript] : [])].join(' ');
    if (Array.from(candidate).length > MAX_COMPOSITION_CHARACTERS) {
      this.dependencies.ui.notify(
        `Voice composition is limited to ${String(MAX_COMPOSITION_CHARACTERS)} characters; the latest segment was not added.`,
        'warning',
      );
      this.actor.send({
        type: 'TRANSCRIPT_COMPOSITION_REJECTED',
        sessionId: effect.sessionId,
        captureId: effect.captureId,
        turnId: effect.turnId,
        revision: effect.revision,
        operation,
      });
      return;
    }
    if (transcript) this.compositionDraft.push(transcript);
    if (operation === 'open')
      this.dependencies.ui.notify(
        'Voice composition started. Say Doom send to submit or Doom cancel to discard.',
        'info',
      );
    this.actor.send({
      type: 'TRANSCRIPT_COMPOSITION_BUFFERED',
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
      operation,
    });
  }

  private requestCompositionSend(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
  ): void {
    const text = this.compositionDraft.join(' ').trim();
    if (!text) {
      this.dependencies.ui.notify('Voice composition is empty. Add content or say Doom cancel.', 'warning');
      this.actor.send({
        type: 'TRANSCRIPT_COMPOSITION_EMPTY_SEND',
        sessionId: effect.sessionId,
        captureId: effect.captureId,
        turnId: effect.turnId,
        revision: effect.revision,
      });
      return;
    }
    this.pendingCompositionSubmission = {
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
    };
    this.actor.send({
      type: 'TRANSCRIPT_COMPOSITION_SEND_REQUESTED',
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
      text,
    });
  }

  private cancelComposition(effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>): void {
    this.clearCompositionDraft();
    this.dependencies.ui.notify('Voice composition draft discarded.', 'info');
    this.actor.send({
      type: 'TRANSCRIPT_COMPOSITION_CANCELLED',
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
    });
  }

  private clearCompositionDraft(): void {
    this.compositionDraft = [];
    this.pendingCompositionSubmission = undefined;
  }

  private abortTranscriptCorrection(): void {
    this.transcriptCorrectionAbort?.abort(new Error('Voice command correction stopped.'));
  }

  private applyPolicy(effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>): void {
    const autoConfig = this.dependencies.config.autoCapture;
    if (!autoConfig) return;
    const result = applyTranscriptPolicy({
      transcript: effect.transcript,
      narrationOverlapPromoted: effect.narrationOverlapPromoted,
      compositionState: effect.compositionState,
      startPhrases: autoConfig.startPhrases,
      stopPhrases: autoConfig.stopPhrases,
      narrationReferences: this.dependencies.narrationReferences(),
    });
    if (result.action === 'deliver') {
      this.correctAndHandleTranscript(effect, result.text, (transcript) => this.acceptTranscript(effect, transcript));
      return;
    }
    if (result.action === 'compose-open' || result.action === 'compose-append') {
      const operation = result.action === 'compose-open' ? 'open' : 'append';
      if (!result.text) {
        this.bufferCompositionSegment(effect, operation, result.text);
        return;
      }
      this.correctAndHandleTranscript(effect, result.text, (transcript) =>
        this.bufferCompositionSegment(effect, operation, transcript),
      );
      return;
    }
    if (result.action === 'compose-send') {
      this.requestCompositionSend(effect);
      return;
    }
    if (result.action === 'compose-cancel') {
      this.cancelComposition(effect);
      return;
    }
    if (result.action === 'stop') {
      this.actor.send({
        sessionId: effect.sessionId,
        captureId: effect.captureId,
        turnId: effect.turnId,
        revision: effect.revision,
        type: 'TRANSCRIPT_STOP_REQUESTED',
      });
      return;
    }
    this.actor.send({
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
      reason: result.reason,
      type: 'TRANSCRIPT_DISCARDED',
    });
  }

  private receiveDeliveryResult(result: VoiceDeliveryResult): void {
    const pending = this.pendingCompositionSubmission;
    const matchesPending =
      pending !== undefined &&
      result.sessionId === pending.sessionId &&
      result.captureId === pending.captureId &&
      result.turnId === pending.turnId &&
      result.revision === pending.revision;
    if (matchesPending) {
      if (result.kind === 'delivered') {
        this.clearCompositionDraft();
        this.dependencies.ui.notify('Voice composition was accepted by Pi.', 'info');
      } else {
        this.pendingCompositionSubmission = undefined;
        this.dependencies.ui.notify('Voice composition was not accepted; the draft was retained.', 'warning');
      }
    }
    if (result.kind === 'delivered') {
      this.actor.send({ type: 'DELIVERY_SUCCEEDED', ...result });
      return;
    }
    this.actor.send({ type: 'DELIVERY_FAILED', ...result });
  }

  private stop(mode: 'graceful' | 'hard'): Promise<void> {
    if (mode === 'hard') {
      this.performHardStop();
      return Promise.resolve();
    }
    this.stopInFlight ??= this.performGracefulStop().finally(() => {
      this.stopInFlight = undefined;
    });
    return this.stopInFlight;
  }

  private async performGracefulStop(): Promise<void> {
    this.prepareStop();
    try {
      await this.dependencies.client.shutdown(SESSION_SHUTDOWN_REASON);
    } catch (error) {
      this.reportCleanupFailure('worker_shutdown', error);
    } finally {
      this.actor.send({ type: 'STOP_COMPLETED' });
    }
  }

  private performHardStop(): void {
    if (this.hardStopStarted) return;
    this.hardStopStarted = true;
    this.prepareStop();
    try {
      void this.dependencies.client
        .shutdown(SESSION_SHUTDOWN_REASON)
        .catch((error: unknown) => this.reportCleanupFailure('worker_shutdown', error));
    } catch (error) {
      this.reportCleanupFailure('worker_shutdown', error);
    }
    this.actor.send({ type: 'STOP_COMPLETED' });
  }

  private requestPlaybackAbort(): void {
    if (this.playbackAbortInFlight) return;
    let operation: Promise<void>;
    try {
      operation = this.dependencies.abortPlayback();
    } catch (error) {
      this.reportCleanupFailure('playback_abort', error);
      return;
    }
    const handled = operation
      .catch((error: unknown) => this.reportCleanupFailure('playback_abort', error))
      .catch(() => undefined);
    this.playbackAbortInFlight = handled;
    void handled.then(() => {
      if (this.playbackAbortInFlight === handled) this.playbackAbortInFlight = undefined;
    });
  }

  private prepareStop(): void {
    this.abortTranscriptCorrection();
    this.delivery.clear();
    if (this.compositionDraft.length > 0)
      this.dependencies.ui.notify('Voice composition draft discarded while stopping autonomous voice.', 'warning');
    this.clearCompositionDraft();
    this.requestPlaybackAbort();
    const identity = this.currentIdentity();
    if (!identity) return;
    try {
      this.dependencies.client.cancelCapture(identity.sessionId, identity.captureId);
    } catch (error) {
      this.reportCleanupFailure('capture_cancel', error);
    }
  }

  private reportCleanupFailure(operation: CleanupOperation, error: unknown): void {
    const failure = { code: `${operation}_failed`, recoverable: false };
    this.dependencies.telemetry?.recordFailure(failure);
    const reason = error instanceof Error ? error.message : String(error);
    this.dependencies.ui.notify(`Autonomous voice ${CLEANUP_OPERATION_LABELS[operation]} failed: ${reason}`, 'error');
  }

  private currentIdentity(): AutonomousTurnIdentity | undefined {
    const context = this.actor.getSnapshot().context;
    if (!context.sessionId || !context.captureId || !context.turnId) return undefined;
    return { sessionId: context.sessionId, captureId: context.captureId, turnId: context.turnId };
  }

  private publishSnapshot(snapshot: AutonomousVoiceSnapshot): void {
    this.dependencies.telemetry?.observe(snapshot, this.dependencies.clock.now());
    const projection = projectAutonomousVoiceUi(snapshot, {
      modalBlocked: this.modalBlocked,
      confirmationPending: false,
    });
    this.dependencies.ui.setIndicator(projection.indicator);
    this.dependencies.ui.setStatus(projection.status);
    const state = activationState(snapshot);
    this.dependencies.onActivationStateChange(state);
    const stopped = state === 'disabled' && this.lastActivationState !== 'disabled';
    this.lastActivationState = state;
    if (stopped) this.dependencies.onStopped();
  }
}
