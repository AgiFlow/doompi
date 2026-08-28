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
import {
  assessVoiceTranscript,
  type RecentVoiceTranscript,
  type VoiceTranscriptAdjudicationDecision,
  type VoiceTranscriptAdjudicationInput,
  type VoiceTranscriptAdmissionAssessment,
} from './transcriptAdmission.ts';
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
const MAX_RECENT_TRANSCRIPTS = 16;
const RECENT_TRANSCRIPT_TTL_MS = 60_000;
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
  adjudicateTranscript?(
    this: void,
    input: VoiceTranscriptAdjudicationInput,
    signal: AbortSignal,
  ): Promise<VoiceTranscriptAdjudicationDecision>;
  narrateContinuation?(this: void, text: string, signal: AbortSignal): Promise<unknown>;
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
  private transcriptAdmissionAbort: AbortController | undefined;
  private pendingTranscriptAdmission:
    | {
        effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>;
        assessment: VoiceTranscriptAdmissionAssessment;
      }
    | undefined;
  private playbackAbortInFlight: Promise<void> | undefined;
  private stopInFlight: Promise<void> | undefined;
  private started = false;
  private lastActivationState: AutoCaptureActivationState = 'disabled';
  private compositionDraft: string[] = [];
  private pendingCompositionSubmission: (AutonomousTurnIdentity & { revision: number }) | undefined;
  private recentTranscripts: RecentVoiceTranscript[] = [];
  private readonly playbackReferences = new Map<number, string>();

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
    this.actor.send({ type: 'TOGGLE_OFF_REQUESTED' });
    this.abortTranscriptCorrection();
    this.abortTranscriptAdmission(true);
  }

  public async shutdown(): Promise<void> {
    if (!this.started || this.actor.getSnapshot().matches('off')) return;
    this.abortTranscriptCorrection();
    this.abortTranscriptAdmission();
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
        ...(event.evidence ? { evidence: event.evidence } : {}),
      });
      return;
    }
    if (event.kind === 'candidate-acknowledged') {
      if (event.turnId === identity.turnId)
        this.actor.send({
          type: 'CANDIDATE_ACKNOWLEDGED',
          ...identity,
          revision: event.revision,
          outcome: event.outcome,
        });
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
    if (referenceText) {
      this.playbackReferences.set(playbackGeneration, referenceText);
      while (this.playbackReferences.size > MAX_RECENT_TRANSCRIPTS) {
        const oldest = this.playbackReferences.keys().next().value;
        if (oldest === undefined) break;
        this.playbackReferences.delete(oldest);
      }
    }
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

  private beginCapture(effect: Extract<AutonomousVoiceEffect, { type: 'effect.beginCapture' }>): void {
    const identity: AutonomousTurnIdentity = {
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
    };
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
        utteranceIdleMs: effect.composing ? autoConfig.composeUtteranceIdleMs : autoConfig.utteranceIdleMs,
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
    if (operation === 'open') {
      const send = this.spokenPhrase('send');
      const cancel = this.spokenPhrase('cancel');
      const how = [...(send ? [`say ${send} to submit`] : []), ...(cancel ? [`say ${cancel} to discard`] : [])].join(
        ', or ',
      );
      // Either list can be configured empty, so the guidance is omitted rather than
      // naming a phrase that would do nothing.
      const guidance = how ? ` ${how.charAt(0).toUpperCase()}${how.slice(1)}.` : '';
      this.dependencies.ui.notify(`Voice composition started.${guidance}`, 'info');
    }
    this.actor.send({
      type: 'TRANSCRIPT_COMPOSITION_BUFFERED',
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
      operation,
    });
  }

  /**
   * The first configured phrase for a composition command, quoted for a notice.
   *
   * These notices are the only instruction a user gets, and a user who reconfigured the
   * phrases, or who is on the shipped defaults after they changed, would otherwise be
   * told to say words that do nothing.
   */
  private spokenPhrase(kind: 'send' | 'cancel'): string | undefined {
    const auto = this.dependencies.config.autoCapture;
    const phrases = kind === 'send' ? auto?.composeSendPhrases : auto?.composeCancelPhrases;
    const phrase = phrases?.[0]?.trim();
    return phrase ? `"${phrase}"` : undefined;
  }

  private requestCompositionSend(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    trailingSegment?: string,
  ): void {
    const segments = [...this.compositionDraft, ...(trailingSegment ? [trailingSegment] : [])];
    const text = segments.join(' ').trim();
    if (Array.from(text).length > MAX_COMPOSITION_CHARACTERS) {
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
        operation: 'append',
      });
      return;
    }
    if (trailingSegment) this.compositionDraft.push(trailingSegment);
    if (!text) {
      const cancel = this.spokenPhrase('cancel');
      this.dependencies.ui.notify(
        cancel
          ? `Voice composition is empty. Add content or say ${cancel} to discard.`
          : 'Voice composition is empty. Add content or cancel it.',
        'warning',
      );
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

  private abortTranscriptAdmission(applyGracefulFallback = false): void {
    const pending = this.pendingTranscriptAdmission;
    this.transcriptAdmissionAbort?.abort(new Error('Voice transcript admission stopped.'));
    this.transcriptAdmissionAbort = undefined;
    this.pendingTranscriptAdmission = undefined;
    if (applyGracefulFallback && pending && this.effectIsCurrent(pending.effect))
      this.applyAdmittedTranscript(
        { ...pending.effect, narrationOverlapPromoted: false },
        pending.assessment.residualText,
      );
  }

  private applyPolicy(effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>): void {
    if (!effect.evidence) {
      this.discardTranscript(effect, 'missing-evidence');
      return;
    }
    if (effect.evidence.playbackOverlapMs > 0 && !effect.narrationOverlapPromoted) {
      this.discardTranscript(effect, 'unauthorized-playback-overlap');
      return;
    }
    const references = this.dependencies.narrationReferences();
    const now = this.dependencies.clock.now();
    this.recentTranscripts = this.recentTranscripts.filter(
      (entry) => now - entry.acceptedAt <= RECENT_TRANSCRIPT_TTL_MS,
    );
    const assessment = assessVoiceTranscript({
      transcript: effect.transcript,
      evidence: effect.evidence,
      observedAt: now,
      narrationOverlap: effect.narrationOverlapPromoted,
      narrationReferences: references,
      recentTranscripts: this.recentTranscripts,
    });
    if (assessment.action === 'reject') {
      this.discardTranscript(effect, assessment.reason);
      return;
    }
    if (assessment.action === 'accept') {
      this.applyAdmittedTranscript(effect, assessment.transcript);
      return;
    }
    this.reviewTranscript(effect, assessment, references);
  }

  private reviewTranscript(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    assessment: VoiceTranscriptAdmissionAssessment,
    references: readonly string[],
  ): void {
    const adjudicate = this.dependencies.adjudicateTranscript;
    if (!adjudicate) {
      this.finishTranscriptAdmission(effect, assessment, this.fallbackAdmission(assessment));
      return;
    }
    this.abortTranscriptAdmission();
    const controller = new AbortController();
    this.transcriptAdmissionAbort = controller;
    this.pendingTranscriptAdmission = { effect, assessment };
    const playbackGeneration = this.snapshot.context.playbackGeneration;
    const narrationText = this.playbackReferences.get(playbackGeneration) ?? references[0];
    const input: VoiceTranscriptAdjudicationInput = {
      assessment,
      ...(narrationText ? { narrationText } : {}),
    };
    void Promise.resolve()
      .then(() => adjudicate(input, controller.signal))
      .then(
        (decision) => this.finishTranscriptAdmission(effect, assessment, decision, controller),
        () => this.finishTranscriptAdmission(effect, assessment, this.fallbackAdmission(assessment), controller),
      );
  }

  private fallbackAdmission(assessment: VoiceTranscriptAdmissionAssessment): VoiceTranscriptAdjudicationDecision {
    const admit = assessment.score >= 85 && assessment.residualText.length > 0 && assessment.narrationSimilarity < 0.75;
    return { admit, reason: admit ? 'user_speech' : 'uncertain' };
  }

  private finishTranscriptAdmission(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    assessment: VoiceTranscriptAdmissionAssessment,
    decision: VoiceTranscriptAdjudicationDecision,
    controller?: AbortController,
  ): void {
    if (controller && this.transcriptAdmissionAbort !== controller) return;
    if (controller) this.pendingTranscriptAdmission = undefined;
    if (!this.effectIsCurrent(effect) || controller?.signal.aborted) return;
    if (!decision.admit) {
      if (controller) this.transcriptAdmissionAbort = undefined;
      this.discardTranscript(effect, decision.reason);
      return;
    }
    const summary = decision.continuationSummary;
    const narrate = this.dependencies.narrateContinuation;
    if (!summary || !narrate || !controller) {
      if (controller) this.transcriptAdmissionAbort = undefined;
      this.applyAdmittedTranscript({ ...effect, narrationOverlapPromoted: false }, assessment.residualText);
      return;
    }
    void Promise.resolve()
      .then(() => narrate(summary, controller.signal))
      .catch(() => undefined)
      .then(() => {
        if (this.transcriptAdmissionAbort !== controller || controller.signal.aborted || !this.effectIsCurrent(effect))
          return;
        this.transcriptAdmissionAbort = undefined;
        this.applyAdmittedTranscript({ ...effect, narrationOverlapPromoted: false }, assessment.residualText);
      });
  }

  private effectIsCurrent(effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>): boolean {
    const snapshot = this.snapshot;
    const context = snapshot.context;
    return (
      snapshot.matches({ active: { capture: 'applyingPolicy' } }) &&
      context.sessionId === effect.sessionId &&
      context.captureId === effect.captureId &&
      context.turnId === effect.turnId &&
      context.revision === effect.revision
    );
  }

  private applyAdmittedTranscript(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    transcript: string,
  ): void {
    const autoConfig = this.dependencies.config.autoCapture;
    if (!autoConfig) return;
    const acceptedAt = this.dependencies.clock.now();
    const result = applyTranscriptPolicy({
      transcript,
      narrationOverlapPromoted: effect.narrationOverlapPromoted,
      compositionState: effect.compositionState,
      startPhrases: autoConfig.startPhrases,
      stopPhrases: autoConfig.stopPhrases,
      compositionPhrases: {
        open: autoConfig.composeOpenPhrases,
        send: autoConfig.composeSendPhrases,
        cancel: autoConfig.composeCancelPhrases,
      },
      narrationReferences: this.dependencies.narrationReferences(),
    });
    if (
      result.action === 'deliver' ||
      result.action === 'compose-open' ||
      result.action === 'compose-append' ||
      (result.action === 'compose-send' && result.text)
    ) {
      this.recentTranscripts.push({ text: transcript, acceptedAt });
      while (this.recentTranscripts.length > MAX_RECENT_TRANSCRIPTS) this.recentTranscripts.shift();
    }
    if (result.action === 'deliver') {
      this.correctAndHandleTranscript(effect, result.text, (corrected) => this.acceptTranscript(effect, corrected));
      return;
    }
    if (result.action === 'compose-open' || result.action === 'compose-append') {
      const operation = result.action === 'compose-open' ? 'open' : 'append';
      if (!result.text) {
        this.bufferCompositionSegment(effect, operation, result.text);
        return;
      }
      this.correctAndHandleTranscript(effect, result.text, (corrected) =>
        this.bufferCompositionSegment(effect, operation, corrected),
      );
      return;
    }
    if (result.action === 'compose-send') {
      // Content spoken ahead of a trailing send command is still user content, so it goes
      // through correction and into the draft before the draft is submitted.
      if (!result.text) {
        this.requestCompositionSend(effect);
        return;
      }
      this.correctAndHandleTranscript(effect, result.text, (corrected) =>
        this.requestCompositionSend(effect, corrected),
      );
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
    this.discardTranscript(effect, result.reason);
  }

  private discardTranscript(
    effect: Extract<AutonomousVoiceEffect, { type: 'effect.applyTranscriptPolicy' }>,
    reason: string,
  ): void {
    this.actor.send({
      sessionId: effect.sessionId,
      captureId: effect.captureId,
      turnId: effect.turnId,
      revision: effect.revision,
      reason,
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
    if (this.stopInFlight) {
      if (mode === 'hard') this.actor.send({ type: 'STOP_COMPLETED' });
      return this.stopInFlight;
    }
    this.stopInFlight = this.performStop(mode);
    return this.stopInFlight;
  }

  private async performStop(_mode: 'graceful' | 'hard'): Promise<void> {
    this.prepareStop();
    const playbackCleanup = this.playbackAbortInFlight ?? Promise.resolve();
    let workerCleanup: Promise<void>;
    try {
      workerCleanup = this.dependencies.client
        .shutdown(SESSION_SHUTDOWN_REASON)
        .catch((error: unknown) => this.reportCleanupFailure('worker_shutdown', error));
    } catch (error) {
      this.reportCleanupFailure('worker_shutdown', error);
      workerCleanup = Promise.resolve();
    }
    await Promise.all([playbackCleanup, workerCleanup]);
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
    this.abortTranscriptAdmission();
    this.delivery.clear();
    this.playbackReferences.clear();
    this.recentTranscripts = [];
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
