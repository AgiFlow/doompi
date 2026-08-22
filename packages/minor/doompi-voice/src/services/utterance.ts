import type { IClock, TimerHandle } from '../types/index.ts';

export const DEFAULT_UTTERANCE_LIMITS: UtteranceLimits = {
  maximumSegments: 16,
  maximumPcmMs: 120_000,
};

export interface UtteranceLimits {
  maximumSegments: number;
  maximumPcmMs: number;
}

export type UtteranceFinalizationReason = 'idle' | 'drain' | 'recovery' | 'limit' | 'shutdown';

export interface PendingUtterance {
  segmentCount: number;
  pcmMs: number;
  deadlineAt: number;
  provisionalSpeech: boolean;
}

export class UtteranceAssembler {
  private pending: PendingUtterance | undefined;
  private timer?: TimerHandle;

  constructor(
    private readonly clock: IClock,
    private readonly idleMs: number,
    private readonly onIdle: () => void,
    private readonly limits: UtteranceLimits = DEFAULT_UTTERANCE_LIMITS,
  ) {}

  get state(): PendingUtterance | undefined {
    return this.pending ? { ...this.pending } : undefined;
  }

  append(closedAt: number, trailingSilenceMs: number, pcmMs: number): boolean {
    const segmentCount = (this.pending?.segmentCount ?? 0) + 1;
    const totalPcmMs = (this.pending?.pcmMs ?? 0) + pcmMs;
    if (segmentCount > this.limits.maximumSegments || totalPcmMs > this.limits.maximumPcmMs) return false;
    this.pending = {
      segmentCount,
      pcmMs: totalPcmMs,
      deadlineAt: Math.max(0, closedAt - trailingSilenceMs + this.idleMs),
      provisionalSpeech: false,
    };
    this.arm();
    return true;
  }

  provisionalStarted(observedAt: number): void {
    const pending = this.pending;
    if (!pending || observedAt > pending.deadlineAt) return;
    pending.provisionalSpeech = true;
    this.clearTimer();
  }

  provisionalEnded(): void {
    const pending = this.pending;
    if (!pending || !pending.provisionalSpeech) return;
    pending.provisionalSpeech = false;
    if (this.clock.now() >= pending.deadlineAt) this.onIdle();
    else this.arm();
  }

  reset(): void {
    this.clearTimer();
    this.pending = undefined;
  }

  private arm(): void {
    this.clearTimer();
    const pending = this.pending;
    if (!pending || pending.provisionalSpeech) return;
    const remainingMs = pending.deadlineAt - this.clock.now();
    if (remainingMs <= 0) {
      this.onIdle();
      return;
    }
    this.timer = this.clock.setTimeout(this.onIdle, remainingMs);
  }

  private clearTimer(): void {
    if (this.timer) this.clock.clear(this.timer);
    this.timer = undefined;
  }
}

interface QueuedTranscription<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class BoundedTranscriptionQueue {
  private readonly queued: QueuedTranscription<unknown>[] = [];
  private active = 0;

  constructor(
    private readonly maximumConcurrent = 2,
    private readonly maximumAccepted = 24,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get acceptedCount(): number {
    return this.active + this.queued.length;
  }

  schedule<T>(run: () => Promise<T>): Promise<T> {
    if (this.acceptedCount >= this.maximumAccepted) return Promise.reject(new Error('Transcription queue is full'));
    return new Promise<T>((resolve, reject) => {
      this.queued.push({ run, resolve, reject } as QueuedTranscription<unknown>);
      this.startNext();
    });
  }

  cancelQueued(error = new Error('Transcription queue was cancelled')): void {
    for (const item of this.queued.splice(0)) item.reject(error);
  }

  private startNext(): void {
    while (this.active < this.maximumConcurrent) {
      const item = this.queued.shift();
      if (!item) return;
      this.active += 1;
      void item
        .run()
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.startNext();
        });
    }
  }
}
