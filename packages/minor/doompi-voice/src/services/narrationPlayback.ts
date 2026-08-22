import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import type { IClock, ITtsAdapter, NarrationKind } from '../types/index.ts';
import {
  NarrationPlaybackCoordinator,
  type NarrationPlaybackOutcome,
  type NarrationPlaybackSettlement,
} from './narration.ts';

const NARRATION_HISTORY_MS = 60_000;
const MAX_RECENT_NARRATIONS = 16;
const NARRATION_PLAYBACK_FAILED_EVENT = 'doom_voice.narration_playback_failed';
const NARRATION_LIFECYCLE_OBSERVER_FAILED_EVENT = 'doom_voice.narration_lifecycle_observer_failed';

export interface VoiceNarrationPlaybackLogger {
  recordError(event: string, error: unknown, attributes?: Record<string, unknown>): void | Promise<void>;
}

export interface VoiceNarrationPlaybackDependencies {
  tts: ITtsAdapter;
  clock: IClock;
  logger: VoiceNarrationPlaybackLogger;
  notify(message: string, level: 'warning'): void;
  onPlaybackStarted(generation: number, referenceText: string): void;
  onPlaybackEnded(generation: number): void;
}

export class VoiceNarrationPlayback {
  private active = false;
  private enabled = true;
  private config: ResolvedVoiceConfig | undefined;
  private playback: NarrationPlaybackCoordinator | undefined;
  private activationGeneration = 0;
  private playbackGeneration = 0;
  private currentNarration: string | undefined;
  private recentNarrations: Array<{ text: string; expiresAt: number }> = [];
  private deactivation: Promise<void> | undefined;

  public constructor(private readonly dependencies: VoiceNarrationPlaybackDependencies) {}

  public activate(config: ResolvedVoiceConfig): void {
    if (this.playback) throw new Error('Voice narration playback must be deactivated before activation.');
    this.active = true;
    this.enabled = true;
    this.config = config;
    const activationGeneration = this.activationGeneration + 1;
    this.activationGeneration = activationGeneration;
    this.playbackGeneration = 0;
    this.currentNarration = undefined;
    this.recentNarrations = [];
    this.playback = new NarrationPlaybackCoordinator(
      this.dependencies.tts,
      (event) => {
        if (activationGeneration !== this.activationGeneration) return;
        if (event.kind === 'started') {
          this.playbackGeneration += 1;
          this.currentNarration = event.request.text;
          this.dependencies.onPlaybackStarted(this.playbackGeneration, event.request.text);
          return;
        }
        this.dependencies.onPlaybackEnded(this.playbackGeneration);
        const result = event.result;
        const retainReference =
          result !== undefined &&
          (result.outcome === 'aborted' ||
            result.outcome === 'stopped' ||
            (result.outcome === 'completed' && result.process.code === 0));
        if (retainReference) {
          this.recentNarrations.push({
            text: event.request.text,
            expiresAt: this.dependencies.clock.now() + NARRATION_HISTORY_MS,
          });
          while (this.recentNarrations.length > MAX_RECENT_NARRATIONS) this.recentNarrations.shift();
        }
        this.currentNarration = undefined;
      },
      (error) => {
        void this.dependencies.logger.recordError(NARRATION_LIFECYCLE_OBSERVER_FAILED_EVENT, error);
      },
    );
  }

  public deactivate(): Promise<void> {
    this.active = false;
    this.deactivation ??= this.finishDeactivation().finally(() => {
      this.deactivation = undefined;
    });
    return this.deactivation;
  }

  public async narrate(
    text: string,
    kind: Extract<NarrationKind, 'final' | 'clarification'>,
    signal?: AbortSignal,
  ): Promise<NarrationPlaybackOutcome> {
    if (!this.active || !this.config || !this.playback) return 'interrupted';
    if (!this.enabled) return 'failed';
    const autoConfig = this.config.autoCapture;
    if (!autoConfig || !text.trim()) return 'failed';

    const settlement = await this.playback.enqueue({ kind, text, config: autoConfig.tts }, signal);
    if (settlement.outcome === 'failed') this.disableAfterFailure(kind, settlement);
    return settlement.outcome;
  }

  public async abortPlayback(): Promise<void> {
    try {
      await this.playback?.abortAll();
    } catch (error) {
      this.disableAfterFailure('final', { outcome: 'failed', error });
      throw error;
    }
  }

  public references(): readonly string[] {
    const now = this.dependencies.clock.now();
    this.recentNarrations = this.recentNarrations.filter((entry) => entry.expiresAt >= now);
    return [
      ...(this.currentNarration ? [this.currentNarration] : []),
      ...this.recentNarrations.map((entry) => entry.text),
    ];
  }

  private async finishDeactivation(): Promise<void> {
    const playback = this.playback;
    try {
      await playback?.abortAll();
    } catch (error) {
      this.disableAfterFailure('final', { outcome: 'failed', error });
    } finally {
      if (this.playback === playback) this.playback = undefined;
      this.config = undefined;
      this.currentNarration = undefined;
      this.recentNarrations = [];
    }
  }

  private disableAfterFailure(kind: NarrationKind, settlement: NarrationPlaybackSettlement): void {
    if (!this.enabled) return;
    this.enabled = false;
    const error = settlement.error ?? new Error('Narration playback failed.');
    void this.dependencies.logger.recordError(NARRATION_PLAYBACK_FAILED_EVENT, error, {
      'narration.kind': kind,
      'narration.outcome': settlement.outcome,
    });
    this.dependencies.notify('Autonomous voice narration was disabled for this activation', 'warning');
  }
}
