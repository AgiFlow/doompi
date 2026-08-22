/** Time and timers as a port, so the background threshold is testable. */
export interface IClock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Schedules `handler` after `ms` and returns a cancel function. */
  after(ms: number, handler: () => void): () => void;
}
