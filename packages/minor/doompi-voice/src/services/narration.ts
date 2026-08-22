import type { VoiceTtsConfig } from '@agimon-ai/doompi-config';
import type {
  ITtsAdapter,
  NarrationKind,
  TtsPlayback,
  TtsPlaybackReference,
  TtsPlaybackResult,
} from '../types/index.ts';

const LIFECYCLE_ERROR_OBSERVER_WARNING = 'Narration lifecycle observer error reporting failed';

const NARRATION_PRIORITY: Record<NarrationKind, number> = {
  intent: 1,
  plan: 2,
  final: 3,
  clarification: 4,
  question: 5,
};

export interface NarrationPlaybackRequest {
  kind: NarrationKind;
  text: string;
  config: VoiceTtsConfig;
}

export type NarrationPlaybackOutcome = 'completed' | 'interrupted' | 'superseded' | 'failed';

export interface NarrationPlaybackSettlement {
  outcome: NarrationPlaybackOutcome;
  reference?: TtsPlaybackReference;
  error?: unknown;
}

export type NarrationPlaybackLifecycleEvent =
  | {
      kind: 'started';
      request: NarrationPlaybackRequest;
      reference: TtsPlaybackReference;
    }
  | {
      kind: 'settled';
      request: NarrationPlaybackRequest;
      reference: TtsPlaybackReference;
      result?: TtsPlaybackResult;
      error?: unknown;
    };

export type NarrationPlaybackLifecycleObserver = (event: NarrationPlaybackLifecycleEvent) => void;
export type NarrationPlaybackLifecycleErrorObserver = (error: unknown) => void;

interface PendingPlayback {
  request: NarrationPlaybackRequest;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
  resolve: (settlement: NarrationPlaybackSettlement) => void;
}

interface ActivePlayback extends PendingPlayback {
  playback: TtsPlayback;
}

interface PlaybackInterruption {
  active: ActivePlayback;
  operation: Promise<void>;
}

function playbackSettlement(result: TtsPlaybackResult): NarrationPlaybackSettlement {
  if (result.outcome === 'completed' && result.process.code === 0) {
    return { outcome: 'completed', reference: { ...result.reference } };
  }
  if (result.outcome === 'aborted' || result.outcome === 'stopped') {
    return { outcome: 'interrupted', reference: { ...result.reference } };
  }
  return { outcome: 'failed', reference: { ...result.reference } };
}

export class NarrationPlaybackCoordinator {
  private active: ActivePlayback | undefined;
  private pending: PendingPlayback | undefined;
  private interrupting: PlaybackInterruption | undefined;
  private nextId = 1;

  private readonly adapter: ITtsAdapter;
  private readonly observeLifecycle: NarrationPlaybackLifecycleObserver;
  private readonly observeLifecycleError: NarrationPlaybackLifecycleErrorObserver;

  constructor(adapter: ITtsAdapter);
  constructor(
    adapter: ITtsAdapter,
    observeLifecycle: NarrationPlaybackLifecycleObserver,
    observeLifecycleError: NarrationPlaybackLifecycleErrorObserver,
  );
  constructor(
    adapter: ITtsAdapter,
    observeLifecycle: NarrationPlaybackLifecycleObserver = () => undefined,
    observeLifecycleError: NarrationPlaybackLifecycleErrorObserver = () => undefined,
  ) {
    this.adapter = adapter;
    this.observeLifecycle = observeLifecycle;
    this.observeLifecycleError = observeLifecycleError;
  }

  get activeReference(): TtsPlaybackReference | undefined {
    return this.active ? { ...this.active.playback.reference } : undefined;
  }

  enqueue(request: NarrationPlaybackRequest, signal?: AbortSignal): Promise<NarrationPlaybackSettlement> {
    return new Promise((resolve) => {
      const pending: PendingPlayback = { request, ...(signal ? { signal } : {}), settled: false, resolve };
      if (signal) {
        pending.onAbort = () => this.cancelRequest(pending);
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      if (signal?.aborted) {
        this.settle(pending, { outcome: 'interrupted' });
        return;
      }

      const active = this.active;
      if (!active) {
        this.start(pending);
        return;
      }
      const requestPriority = NARRATION_PRIORITY[request.kind];
      const activePriority = NARRATION_PRIORITY[active.request.kind];
      const pendingPriority = this.pending ? NARRATION_PRIORITY[this.pending.request.kind] : 0;
      if (requestPriority < pendingPriority) {
        this.settle(pending, { outcome: 'superseded' });
        return;
      }
      if (this.pending) this.settle(this.pending, { outcome: 'superseded' });
      this.pending = pending;
      if (requestPriority > activePriority) this.interruptActive();
    });
  }

  async cancelBelow(kind: NarrationKind): Promise<void> {
    const minimumPriority = NARRATION_PRIORITY[kind];
    if (this.pending && NARRATION_PRIORITY[this.pending.request.kind] < minimumPriority) {
      this.settle(this.pending, { outcome: 'interrupted' });
      this.pending = undefined;
    }
    const active = this.active;
    if (!active || NARRATION_PRIORITY[active.request.kind] >= minimumPriority) return;
    await this.abortActive(active);
  }

  async abortAll(): Promise<void> {
    if (this.pending) this.settle(this.pending, { outcome: 'interrupted' });
    this.pending = undefined;
    const active = this.active;
    if (!active) return;
    await this.abortActive(active);
  }

  private cancelRequest(request: PendingPlayback): void {
    if (request.settled) return;
    if (this.pending === request) {
      this.pending = undefined;
      this.settle(request, { outcome: 'interrupted' });
      return;
    }
    if (this.active === request) {
      void this.abortActive(request as ActivePlayback).catch(() => undefined);
      return;
    }
    this.settle(request, { outcome: 'interrupted' });
  }

  private start(pending: PendingPlayback): void {
    if (pending.signal?.aborted) {
      this.settle(pending, { outcome: 'interrupted' });
      this.startPending();
      return;
    }
    let playback: TtsPlayback;
    try {
      playback = this.adapter.speak({ id: this.nextId++, ...pending.request });
    } catch (error) {
      this.settle(pending, { outcome: 'failed', error });
      this.startPending();
      return;
    }
    const active = pending as ActivePlayback;
    active.playback = playback;
    this.active = active;
    this.observe({
      kind: 'started',
      request: active.request,
      reference: { ...playback.reference },
    });
    void playback.completion.then(
      (result) => this.complete(active, result),
      (error: unknown) => this.fail(active, error),
    );
  }

  private interruptActive(): void {
    const active = this.active;
    if (!active) return;
    void this.abortActive(active).catch(() => undefined);
  }

  private abortActive(active: ActivePlayback): Promise<void> {
    if (this.interrupting?.active === active) return this.interrupting.operation;
    const operation = this.performAbort(active).finally(() => {
      if (this.interrupting?.active === active) this.interrupting = undefined;
    });
    this.interrupting = { active, operation };
    return operation;
  }

  private async performAbort(active: ActivePlayback): Promise<void> {
    let abortFailed = false;
    let abortError: unknown;
    try {
      await active.playback.abort();
    } catch (error) {
      abortFailed = true;
      abortError = error;
    }
    let completionFailed = false;
    let completionError: unknown;
    try {
      await active.playback.completion;
    } catch (error) {
      completionFailed = true;
      completionError = error;
    }
    if (abortFailed) throw abortError;
    if (completionFailed) throw completionError;
  }

  private complete(active: ActivePlayback, result: TtsPlaybackResult): void {
    if (!this.takeActive(active)) return;
    this.observe({
      kind: 'settled',
      request: active.request,
      reference: { ...result.reference },
      result,
    });
    const settlement = playbackSettlement(result);
    this.settle(active, settlement);
    if (settlement.outcome === 'failed') {
      this.failPending(new Error('Narration playback failed.'));
      return;
    }
    this.startPending();
  }

  private fail(active: ActivePlayback, error: unknown): void {
    if (!this.takeActive(active)) return;
    this.observe({
      kind: 'settled',
      request: active.request,
      reference: { ...active.playback.reference },
      error,
    });
    this.settle(active, { outcome: 'failed', reference: { ...active.playback.reference }, error });
    this.failPending(error);
  }

  private settle(pending: PendingPlayback, settlement: NarrationPlaybackSettlement): boolean {
    if (pending.settled) return false;
    pending.settled = true;
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    pending.resolve(settlement);
    return true;
  }

  private takeActive(active: ActivePlayback): boolean {
    if (this.active !== active) return false;
    this.active = undefined;
    return true;
  }

  private observe(event: NarrationPlaybackLifecycleEvent): void {
    try {
      this.observeLifecycle(event);
    } catch (error) {
      try {
        this.observeLifecycleError(error);
      } catch (observerError) {
        const message = observerError instanceof Error ? observerError.message : String(observerError);
        process.emitWarning(`${LIFECYCLE_ERROR_OBSERVER_WARNING}: ${message}`);
      }
    }
  }

  private failPending(error: unknown): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.settle(pending, { outcome: 'failed', error });
  }

  private startPending(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.start(pending);
  }
}
