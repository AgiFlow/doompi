import os from 'node:os';
import path from 'node:path';

import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import type { AutonomousTurnNonceFactory } from '../../services/autonomousTurn.ts';
import { AutonomousVoiceSession } from '../../services/autonomousVoiceSession.ts';
import {
  AutonomousVoiceTelemetry,
  type AutonomousVoiceTelemetrySink,
} from '../../services/autonomousVoiceTelemetry.ts';
import type { IVoiceCommandCorrector, VoiceCommandContext } from '../../services/commandCorrection.ts';
import type { IVoiceNarrationCompactor, IVoiceTurnFallbackNarrator } from '../../services/fallbackNarration.ts';
import type { NarrationPlaybackOutcome } from '../../services/narration.ts';
import { VoiceNarrationPlayback, type VoiceNarrationPlaybackLogger } from '../../services/narrationPlayback.ts';
import type { IVoiceTranscriptAdjudicator } from '../../services/transcriptAdmission.ts';
import type { VoiceDeliveryIntent } from '../../services/voiceDelivery.ts';
import type { AutoCaptureActivationState, AutoCaptureUi, IClock, ITtsAdapter } from '../../types/index.ts';
import { VoiceWorkerClient, type VoiceWorkerClientOptions } from './voiceWorkerClient.ts';
import type { VoiceWorkerSessionClientFactory } from './voiceWorkerSessionController.ts';

const FALLBACK_NARRATION_GENERATION_FAILED_EVENT = 'doom_voice.fallback_narration_generation_failed';

function spoolRoot(): string {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDirectory, 'doom-voice', 'spool');
}

export interface VoiceWorkerAutoCaptureTelemetrySink extends AutonomousVoiceTelemetrySink {
  recordError: VoiceNarrationPlaybackLogger['recordError'];
  shutdown(): Promise<void>;
}

export interface VoiceWorkerAutoCaptureDependencies {
  loadConfig(): ResolvedVoiceConfig;
  resolveCommandCorrector(reference: string): Promise<IVoiceCommandCorrector | undefined>;
  resolveTranscriptAdjudicator?(reference: string): Promise<IVoiceTranscriptAdjudicator | undefined>;
  resolveFallbackNarrator(reference: string): Promise<IVoiceTurnFallbackNarrator & Partial<IVoiceNarrationCompactor>>;
  tts: ITtsAdapter;
  clock: IClock;
  deliver(text: string, intent?: VoiceDeliveryIntent): void;
  manualState(): 'idle' | 'recording' | 'transcribing';
  commandContext?(): VoiceCommandContext | undefined;
  onActivationStateChange?(state: AutoCaptureActivationState): void;
  clientFactory?: VoiceWorkerSessionClientFactory;
  telemetrySink?: VoiceWorkerAutoCaptureTelemetrySink;
  identityNonceFactory?: AutonomousTurnNonceFactory;
}

export class VoiceWorkerAutoCaptureController {
  private activationState: AutoCaptureActivationState = 'disabled';
  private activationRevision = 0;
  private session: AutonomousVoiceSession | undefined;
  private ui: AutoCaptureUi | undefined;
  private readonly narration: VoiceNarrationPlayback;
  private readonly telemetrySink: VoiceWorkerAutoCaptureTelemetrySink;
  private readonly telemetry: AutonomousVoiceTelemetry;
  private fallbackNarrator: (IVoiceTurnFallbackNarrator & Partial<IVoiceNarrationCompactor>) | undefined;
  private fallbackNarration: AbortController | undefined;
  private shutdownInFlight: Promise<void> | undefined;
  private activationErrorMessage: string | undefined;
  private readonly disabledWaiters = new Set<() => void>();
  private disposed = false;

  public constructor(private readonly dependencies: VoiceWorkerAutoCaptureDependencies) {
    this.telemetrySink =
      dependencies.telemetrySink ??
      createDoomTelemetry({
        serviceName: 'doom-voice-autonomous',
        packageName: '@agimon-ai/doompi-voice',
        env: process.env,
        enableLogs: true,
        enableTraces: true,
      });
    this.telemetry = new AutonomousVoiceTelemetry(this.telemetrySink, dependencies.clock.now());
    this.narration = new VoiceNarrationPlayback({
      tts: dependencies.tts,
      clock: dependencies.clock,
      logger: this.telemetrySink,
      notify: (message, level) => this.ui?.notify(message, level),
      onPlaybackStarted: (generation, referenceText) => this.session?.playbackStarted(generation, referenceText),
      onPlaybackEnded: (generation) => this.session?.playbackEnded(generation),
    });
  }

  public get state(): AutoCaptureActivationState {
    return this.activationState;
  }

  public get activationId(): number {
    return this.activationRevision;
  }

  public get activationError(): string | undefined {
    return this.activationErrorMessage;
  }

  public get microphoneMuted(): boolean {
    return this.session?.microphoneMuted ?? false;
  }

  public setMicrophoneMuted(muted: boolean): void {
    if (this.activationState === 'disabled' || this.disposed) return;
    this.session?.setMicrophoneMuted(muted);
  }

  public async toggle(ui: AutoCaptureUi): Promise<void> {
    if (this.activationState === 'disabled') {
      await this.activate(ui);
      return;
    }
    await this.deactivate(ui);
  }

  public async activate(ui: AutoCaptureUi): Promise<void> {
    this.ui = ui;
    if (this.disposed) {
      ui.notify('Autonomous voice has been shut down', 'error');
      return;
    }
    if (this.activationState === 'draining') await this.waitUntilDisabled();
    if (this.disposed) {
      ui.notify('Autonomous voice has been shut down', 'error');
      return;
    }
    if (this.activationState !== 'disabled') return;
    await this.enable(ui);
  }

  public async deactivate(ui: AutoCaptureUi): Promise<void> {
    this.ui = ui;
    if (this.activationState === 'disabled' || this.disposed) return;
    if (this.activationState === 'starting') {
      this.activationRevision += 1;
      const session = this.session;
      try {
        await session?.shutdown();
      } catch (error) {
        ui.notify(
          `Autonomous voice failed to stop: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      } finally {
        await this.resetLocal(ui, session);
      }
      return;
    }
    this.session?.toggleOff();
  }

  public shutdown(ui = this.ui): Promise<void> {
    this.shutdownInFlight ??= this.performShutdown(ui);
    return this.shutdownInFlight;
  }

  public narrateAgent(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome> {
    if (this.activationState !== 'active') return Promise.resolve('interrupted');
    return this.narration.narrate(text, 'final', signal);
  }

  public narrateExternal(text: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome> {
    if (this.activationState !== 'active') return Promise.resolve('interrupted');
    return this.narration.narrate(text, 'clarification', signal);
  }

  public async narrateFallback(finalResponse: string, signal?: AbortSignal): Promise<NarrationPlaybackOutcome> {
    const narrator = this.fallbackNarrator;
    if (this.activationState !== 'active') return 'interrupted';
    if (!narrator) return 'failed';

    this.abortFallbackNarration('Fallback narration was superseded by a newer turn.');
    const controller = new AbortController();
    const cancel = (): void => controller.abort(signal?.reason);
    if (signal) {
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }
    this.fallbackNarration = controller;

    try {
      const fallback = await narrator.create(finalResponse, controller.signal);
      if (fallback.generationError) {
        void this.telemetrySink.recordError(FALLBACK_NARRATION_GENERATION_FAILED_EVENT, fallback.generationError, {
          'narration.fallback_source': fallback.source,
        });
      }
      if (controller.signal.aborted || this.fallbackNarration !== controller || this.activationState !== 'active')
        return 'interrupted';
      return await this.narration.narrate(fallback.text, 'final', controller.signal);
    } catch (error) {
      if (controller.signal.aborted || this.activationState !== 'active') return 'interrupted';
      void this.telemetrySink.recordError(FALLBACK_NARRATION_GENERATION_FAILED_EVENT, error, {
        'narration.fallback_source': 'failed',
      });
      this.ui?.notify('Autonomous voice fallback narration failed', 'warning');
      return 'failed';
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.fallbackNarration === controller) this.fallbackNarration = undefined;
    }
  }

  public askUserBlocked(blocked: boolean): void {
    this.session?.setModalBlocked(blocked);
  }

  private async performShutdown(ui?: AutoCaptureUi): Promise<void> {
    this.disposed = true;
    this.activationRevision += 1;
    this.setState('shuttingDown');
    const session = this.session;
    try {
      await this.narration.abortPlayback().catch(() => undefined);
      await session?.shutdown();
    } finally {
      if (this.session === session) await this.resetLocal(ui, session);
      await this.telemetrySink.shutdown();
    }
  }

  private async enable(ui: AutoCaptureUi): Promise<void> {
    this.activationErrorMessage = undefined;
    const revision = this.activationRevision + 1;
    this.activationRevision = revision;
    this.setState('starting');
    ui.setIndicator('processing');
    ui.setStatus('voice auto: starting');
    let createdSession: AutonomousVoiceSession | undefined;
    try {
      if (this.dependencies.manualState() !== 'idle')
        throw new Error('Stop manual voice recording before enabling voice auto');
      const config = this.dependencies.loadConfig();
      const autoConfig = config.autoCapture;
      if (!autoConfig) throw new Error('Autonomous voice is not configured in ~/.pi/.doom/config.yaml');
      this.dependencies.tts.preflight(autoConfig.tts);
      const [corrector, adjudicator, fallbackNarrator] = await Promise.all([
        this.dependencies.resolveCommandCorrector(autoConfig.model),
        this.dependencies.resolveTranscriptAdjudicator?.(autoConfig.model),
        this.dependencies.resolveFallbackNarrator(autoConfig.model),
      ]);
      if (revision !== this.activationRevision || this.activationState !== 'starting') return;
      this.fallbackNarrator = fallbackNarrator;
      const clientOptions: VoiceWorkerClientOptions = {
        spoolDirectory: spoolRoot(),
        onEvent: (event) => createdSession?.receive(event),
        onExhausted: (reason) => createdSession?.workerExhausted(`worker_${reason}`),
      };
      const client = this.dependencies.clientFactory
        ? this.dependencies.clientFactory(clientOptions)
        : new VoiceWorkerClient(clientOptions);
      createdSession = new AutonomousVoiceSession({
        config,
        client,
        clock: this.dependencies.clock,
        ui,
        deliver: (text, intent) => (intent ? this.dependencies.deliver(text, intent) : this.dependencies.deliver(text)),
        narrationReferences: () => this.narration.references(),
        abortPlayback: () => this.narration.abortPlayback(),
        narrateContinuation: (text, signal) => this.narration.narrate(text, 'clarification', signal),
        ...(adjudicator
          ? {
              adjudicateTranscript: (input, signal) =>
                adjudicator.decide({ ...input, context: this.dependencies.commandContext?.() }, signal),
            }
          : {}),
        ...(corrector
          ? {
              correctTranscript: (transcript: string, signal: AbortSignal) =>
                corrector.correct({ transcript, context: this.dependencies.commandContext?.() }, signal),
            }
          : {}),
        telemetry: this.telemetry,
        onActivationStateChange: (state) => {
          if (state !== 'disabled') this.setState(state);
        },
        onNarrationDeferredChange: (deferred) => this.narration.setDeferred(deferred),
        ...(this.dependencies.identityNonceFactory
          ? { identityNonceFactory: this.dependencies.identityNonceFactory }
          : {}),
        onStopped: () => {
          if (this.session === createdSession) void this.resetLocal(ui, createdSession);
        },
      });
      this.session = createdSession;
      this.narration.activate(
        config,
        fallbackNarrator.compact
          ? { compact: (narrations, signal) => fallbackNarrator.compact!(narrations, signal) }
          : undefined,
      );
      await createdSession.start();
      if (revision !== this.activationRevision || this.session !== createdSession || this.disposed) {
        await createdSession.shutdown();
      }
    } catch (error) {
      if (revision !== this.activationRevision) return;
      const message = error instanceof Error ? error.message : String(error);
      this.activationErrorMessage = message.slice(0, 300);
      if (createdSession && this.session === createdSession) {
        try {
          await createdSession.shutdown();
        } catch (cleanupError) {
          ui.notify(
            `Autonomous voice failed to clean up after startup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            'error',
          );
        }
      }
      await this.resetLocal(ui, createdSession);
      ui.notify(message, 'error');
    }
  }

  private setState(state: AutoCaptureActivationState): void {
    if (this.activationState === state) return;
    this.activationState = state;
    if (state !== 'active') this.abortFallbackNarration('Autonomous voice is no longer active.');
    this.dependencies.onActivationStateChange?.(state);
    if (state !== 'disabled') return;
    for (const resolve of this.disabledWaiters) resolve();
    this.disabledWaiters.clear();
  }

  private waitUntilDisabled(): Promise<void> {
    if (this.activationState === 'disabled') return Promise.resolve();
    return new Promise((resolve) => this.disabledWaiters.add(resolve));
  }

  private async resetLocal(ui?: AutoCaptureUi, expectedSession?: AutonomousVoiceSession): Promise<void> {
    if (expectedSession && this.session !== expectedSession) return;
    this.abortFallbackNarration('Autonomous voice session ended.');
    await this.narration.deactivate();
    if (expectedSession && this.session !== expectedSession) return;
    this.session = undefined;
    this.fallbackNarrator = undefined;
    this.setState('disabled');
    ui?.setIndicator(undefined);
    ui?.setStatus(undefined);
  }

  private abortFallbackNarration(message: string): void {
    const fallback = this.fallbackNarration;
    this.fallbackNarration = undefined;
    if (!fallback || fallback.signal.aborted) return;
    const error = new Error(message);
    error.name = 'AbortError';
    fallback.abort(error);
  }
}
