import type { IClock } from '../../types/clock';

/** Real wall clock and timers. */
export class SystemClock implements IClock {
  now(): number {
    return Date.now();
  }

  after(ms: number, handler: () => void): () => void {
    const timer = setTimeout(handler, ms);
    // The timer must never be the reason the host process stays alive.
    timer.unref?.();
    return () => clearTimeout(timer);
  }
}
