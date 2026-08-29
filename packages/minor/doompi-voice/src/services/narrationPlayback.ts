import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';
import type { IClock, ITtsAdapter, NarrationKind } from '../types/index.ts';
import type { IVoiceNarrationCompactor } from './fallbackNarration.ts';
import {
  NarrationPlaybackCoordinator,
  type NarrationPlaybackOutcome,
  type NarrationPlaybackSettlement,
} from './narration.ts';

const NARRATION_HISTORY_MS = 60_000;
const MAX_RECENT_NARRATIONS = 16;
const NARRATION_PLAYBACK_FAILED_EVENT = 'doom_voice.narration_playback_failed';
const NARRATION_LIFECYCLE_OBSERVER_FAILED_EVENT = 'doom_voice.narration_lifecycle_observer_failed';
const NARRATION_COMPACTION_FAILED_EVENT = 'doom_voice.narration_compaction_failed';

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

interface NarrationCaller {
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(outcome: NarrationPlaybackOutcome): void;
}

interface QueuedNarration {
  text: string;
  kind: Extract<NarrationKind, 'final' | 'clarification'>;
  callers: NarrationCaller[];
  abort?: AbortController;
}

interface NarrationCompaction {
  generation: number;
  controller: AbortController;
  entries: QueuedNarration[];
}

export class VoiceNarrationPlayback {
  private active = false;
  private enabled = true;
  private config: ResolvedVoiceConfig | undefined;
  private compactor: IVoiceNarrationCompactor | undefined;
  private playback: NarrationPlaybackCoordinator | undefined;
  private activationGeneration = 0;
  private playbackGeneration = 0;
  private currentNarration: string | undefined;
  private recentNarrations: Array<{ text: string; expiresAt: number }> = [];
  private activeNarration: QueuedNarration | undefined;
  private pendingNarrations: QueuedNarration[] = [];
  private compaction: NarrationCompaction | undefined;
  private deactivation: Promise<void> | undefined;

  public constructor(private readonly dependencies: VoiceNarrationPlaybackDependencies) {}

  public activate(config: ResolvedVoiceConfig, compactor?: IVoiceNarrationCompactor): void {
    if (this.playback) throw new Error('Voice narration playback must be deactivated before activation.');
    this.active = true;
    this.enabled = true;
    this.config = config;
    this.compactor = compactor;
    const activationGeneration = this.activationGeneration + 1;
    this.activationGeneration = activationGeneration;
    this.playbackGeneration = 0;
    this.currentNarration = undefined;
    this.recentNarrations = [];
    this.activeNarration = undefined;
    this.pendingNarrations = [];
    this.compaction = undefined;
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

  public narrate(
    text: string,
    kind: Extract<NarrationKind, 'final' | 'clarification'>,
    signal?: AbortSignal,
  ): Promise<NarrationPlaybackOutcome> {
    if (!this.active || !this.config || !this.playback) return Promise.resolve('interrupted');
    if (!this.enabled) return Promise.resolve('failed');
    if (!this.config.autoCapture || !text.trim()) return Promise.resolve('failed');

    return new Promise((resolve) => {
      const caller: NarrationCaller = { settled: false, ...(signal ? { signal } : {}), resolve };
      const entry: QueuedNarration = { text, kind, callers: [caller] };
      if (signal) {
        caller.onAbort = () => this.cancelCaller(caller);
        signal.addEventListener('abort', caller.onAbort, { once: true });
      }
      if (signal?.aborted) {
        this.settleCaller(caller, 'interrupted');
        return;
      }
      if (!this.activeNarration && !this.compaction && this.pendingNarrations.length === 0) {
        this.startNarration(entry);
        return;
      }
      this.pendingNarrations.push(entry);
      this.compactPending();
    });
  }

  public async abortPlayback(): Promise<void> {
    this.clearQueued('interrupted');
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

  private compactPending(): void {
    const compactor = this.compactor;
    if (!compactor || this.compaction || this.pendingNarrations.length < 2) return;
    const entries = this.pendingNarrations.splice(0);
    const controller = new AbortController();
    const operation: NarrationCompaction = {
      generation: this.activationGeneration,
      controller,
      entries,
    };
    this.compaction = operation;
    void Promise.resolve()
      .then(() =>
        compactor.compact(
          entries.map((entry) => entry.text),
          controller.signal,
        ),
      )
      .then(
        (summary) => this.finishCompaction(operation, summary),
        (error: unknown) => this.failCompaction(operation, error),
      );
  }

  private finishCompaction(operation: NarrationCompaction, summary: string): void {
    if (
      this.compaction !== operation ||
      operation.generation !== this.activationGeneration ||
      operation.controller.signal.aborted
    )
      return;
    this.compaction = undefined;
    const callers = operation.entries.flatMap((entry) => entry.callers).filter((caller) => !caller.settled);
    if (callers.length > 0) {
      const kind = operation.entries.some((entry) => entry.kind === 'clarification') ? 'clarification' : 'final';
      this.pendingNarrations.unshift({ text: summary, kind, callers });
    }
    this.compactPending();
    this.pump();
  }

  private failCompaction(operation: NarrationCompaction, error: unknown): void {
    if (
      this.compaction !== operation ||
      operation.generation !== this.activationGeneration ||
      operation.controller.signal.aborted
    )
      return;
    this.compaction = undefined;
    const retained = operation.entries.filter((entry) => entry.callers.some((caller) => !caller.settled));
    this.pendingNarrations.unshift(...retained);
    this.pump();
    try {
      void this.dependencies.logger.recordError(NARRATION_COMPACTION_FAILED_EVENT, error);
    } catch {
      // Telemetry must never affect FIFO fallback.
    }
  }

  private startNarration(entry: QueuedNarration): void {
    if (!this.playback || !this.config?.autoCapture || !this.active || !this.enabled) {
      this.settleEntry(entry, this.active ? 'failed' : 'interrupted');
      return;
    }
    const abort = new AbortController();
    entry.abort = abort;
    this.activeNarration = entry;
    void this.playback
      .enqueue({ kind: entry.kind, text: entry.text, config: this.config.autoCapture.tts }, abort.signal)
      .then((settlement) => this.finishNarration(entry, settlement));
  }

  private finishNarration(entry: QueuedNarration, settlement: NarrationPlaybackSettlement): void {
    if (this.activeNarration !== entry) return;
    this.activeNarration = undefined;
    this.settleEntry(entry, settlement.outcome);
    if (settlement.outcome === 'failed') {
      this.disableAfterFailure(entry.kind, settlement);
      this.clearQueued('failed');
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (this.activeNarration || this.compaction || !this.active || !this.enabled) return;
    const next = this.pendingNarrations.shift();
    if (next) this.startNarration(next);
  }

  private cancelCaller(caller: NarrationCaller): void {
    if (!this.settleCaller(caller, 'interrupted')) return;
    const entry =
      (this.activeNarration?.callers.includes(caller) ? this.activeNarration : undefined) ??
      this.pendingNarrations.find((candidate) => candidate.callers.includes(caller)) ??
      this.compaction?.entries.find((candidate) => candidate.callers.includes(caller));
    if (!entry || entry.callers.some((candidate) => !candidate.settled)) return;
    if (this.activeNarration === entry) {
      entry.abort?.abort(caller.signal?.reason);
      return;
    }
    const index = this.pendingNarrations.indexOf(entry);
    if (index >= 0) this.pendingNarrations.splice(index, 1);
  }

  private settleCaller(caller: NarrationCaller, outcome: NarrationPlaybackOutcome): boolean {
    if (caller.settled) return false;
    caller.settled = true;
    if (caller.signal && caller.onAbort) caller.signal.removeEventListener('abort', caller.onAbort);
    caller.resolve(outcome);
    return true;
  }

  private settleEntry(entry: QueuedNarration, outcome: NarrationPlaybackOutcome): void {
    for (const caller of entry.callers) this.settleCaller(caller, outcome);
  }

  private clearQueued(outcome: NarrationPlaybackOutcome): void {
    const compaction = this.compaction;
    this.compaction = undefined;
    if (compaction) {
      compaction.controller.abort(new Error('Narration compaction stopped.'));
      for (const entry of compaction.entries) this.settleEntry(entry, outcome);
    }
    for (const entry of this.pendingNarrations) this.settleEntry(entry, outcome);
    this.pendingNarrations = [];
  }

  private async finishDeactivation(): Promise<void> {
    const playback = this.playback;
    this.clearQueued('interrupted');
    try {
      await playback?.abortAll();
    } catch (error) {
      this.disableAfterFailure('final', { outcome: 'failed', error });
    } finally {
      if (this.playback === playback) this.playback = undefined;
      this.config = undefined;
      this.compactor = undefined;
      this.currentNarration = undefined;
      this.recentNarrations = [];
      this.activeNarration = undefined;
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
