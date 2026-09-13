/**
 * One master tick that drives every background subscriber in the runner
 * process: channels, watchers, inspectors, anything that used to own its own
 * `setInterval`.
 *
 * WHY ONE TICK AND NOT ONE TIMER PER SUBSCRIBER:
 * The predecessor package (`doom-pi-subagents`) gave every channel, watcher
 * and inspector its own independent interval. None of them coordinated, all of
 * them kept firing when nothing was happening, and the parent process burned
 * CPU while completely idle. A single scheduler that every subscriber reports
 * to can decide, once, whether there is any reason to keep ticking quickly.
 *
 * IDLE BACKOFF:
 * The tick interval starts at `floorMs`. A tick where nothing reported work
 * multiplies the interval by `backoffMultiplier`, capped at `ceilingMs`. A tick
 * where anything reported work resets it straight back to `floorMs`. "Reported
 * work" means a subscriber's `run()` returned `true`; returning `false` or
 * `void` means it checked and found nothing to do.
 *
 * WATCH-FIRST, POLL AS A SAFETY NET:
 * The intended pattern is: a subscriber's own `intervalMs` is set generously
 * (roughly 4x looser than how quickly you actually want it checked), and a
 * filesystem watch is the fast path. When the watch fires, its handler calls
 * `wake()`, which runs every subscriber immediately regardless of backoff.
 * Polling on `intervalMs` only exists to cover the platforms and mount types
 * where filesystem watches are unreliable or simply do not fire. Neither path
 * is trusted alone: the watch gives latency, the poll interval gives a bound
 * on how late a check can ever be.
 *
 * DESIGN PATTERNS:
 * - Subscribers are checked for both "due" (their own `intervalMs` has
 *   elapsed) and "forced" (a `wake()` call), so a fast-changing subscriber and
 *   a rarely-changing one can share one clock without either starving
 * - A subscriber's key is internal and never the caller-supplied `id`, so two
 *   subscribers that reuse the same `id` string (a plausible mistake with
 *   per-run subscriber names) cannot make one's `unregister()` delete the
 *   other's registration
 * - Synchronous subscribers still complete in the same tick. Async subscribers
 *   are awaited sequentially, and forced wakes coalesce behind the active tick,
 *   so slow filesystem work never creates overlapping scans
 *
 * AVOID:
 * - Reading `this.floorMs` (or the other seam fields) from the constructor:
 *   field initializer order runs the base class's defaults before a test
 *   subclass's overrides are applied, so a value read in the constructor would
 *   see the base default even when a subclass overrides it. Everything that
 *   needs these values reads them lazily, from `start()` or `tick()`, which run
 *   after construction is complete
 * - Letting a subscriber's thrown error escape `tick()`; it must not stop the
 *   tick or affect its peers. It is recorded rather than discarded, since a
 *   subscriber that throws every tick otherwise looks identical to an idle one
 */

/** Minimum spacing between ticks once nothing has reported work in a while. */
const DEFAULT_FLOOR_MS = 200;
/** Ceiling the backoff grows toward while idle. */
const DEFAULT_CEILING_MS = 5_000;
/** Growth factor applied to the tick interval on every idle tick. */
const DEFAULT_BACKOFF_MULTIPLIER = 2;

export interface PollSubscription {
  /** For readability in logs and error messages only; not used as a map key. */
  id: string;
  /** How often this subscriber is checked, in milliseconds. Must be positive. */
  intervalMs: number;
  /**
   * Called when due. Return `true` when it did real work, which resets the
   * scheduler's backoff to the floor. Return `false` or nothing when there was
   * nothing to do, which lets idle backoff continue growing.
   */
  run: () => boolean | void | Promise<boolean | undefined>;
}

export type PollSchedulerContract = {
  /** Register a subscriber. Call the returned function to unregister it. */
  register(subscription: PollSubscription): () => void;
  /** Run every subscriber immediately, bypassing backoff and due-checks. */
  wake(): void;
  /** Begin ticking. Idempotent: a second call while running does nothing. */
  start(): void;
  /** Stop ticking and clear the pending timer. Idempotent. */
  stop(): void;
};

interface InternalSubscriber extends PollSubscription {
  /** `undefined` until the first tick runs it; never `0`, which a test clock may legitimately start at. */
  lastRunAt: number | undefined;
}

export class PollScheduler implements PollSchedulerContract {
  /**
   * Runtime tuning seams for tests, kept out of the dependency constructor.
   */
  protected readonly floorMs: number = DEFAULT_FLOOR_MS;
  protected readonly ceilingMs: number = DEFAULT_CEILING_MS;
  protected readonly backoffMultiplier: number = DEFAULT_BACKOFF_MULTIPLIER;

  protected now(): number {
    return Date.now();
  }

  /**
   * Records a subscriber that threw. Overridable, and deliberately not a
   * stdio write: this runs inside a detached runner whose stdout is the child's
   * captured transcript. The composition root routes these into that process's
   * own diagnostics; the default keeps the most recent one queryable so a
   * failing subscriber can still be found after the fact.
   */
  protected onSubscriberError(id: string, error: unknown): void {
    this.lastSubscriberError = { id, error, at: this.now() };
    this.subscriberErrorCount += 1;
  }

  /** The most recent subscriber failure, for diagnostics. */
  lastSubscriberError: { id: string; error: unknown; at: number } | undefined;
  /** How many subscriber failures this scheduler has absorbed. */
  subscriberErrorCount = 0;

  private readonly subscribers = new Map<number, InternalSubscriber>();
  private nextSubscriberKey = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private currentIntervalMs: number | undefined;
  private running = false;
  private tickRunning = false;
  private forcedTickQueued = false;
  private generation = 0;

  register(subscription: PollSubscription): () => void {
    if (!(subscription.intervalMs > 0)) {
      throw new Error(`Poll subscriber "${subscription.id}" must have a positive intervalMs.`);
    }
    const key = this.nextSubscriberKey++;
    this.subscribers.set(key, { ...subscription, lastRunAt: undefined });
    return () => {
      this.subscribers.delete(key);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.currentIntervalMs = this.floorMs;
    this.tick(false);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.forcedTickQueued = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  wake(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tick(true);
  }

  /**
   * Run every due subscriber (or, when `forced`, every subscriber), fold the
   * outcome into the backoff curve, and schedule the next tick.
   */
  private tick(forced: boolean): void {
    if (this.tickRunning) {
      this.forcedTickQueued ||= forced;
      return;
    }

    this.tickRunning = true;
    const generation = this.generation;
    const timestamp = this.now();
    const subscribers = [...this.subscribers.values()];
    let workHappened = false;
    let anySubscriberRan = false;

    const finish = (): void => {
      if (generation === this.generation && anySubscriberRan) {
        const previousIntervalMs = this.currentIntervalMs ?? this.floorMs;
        this.currentIntervalMs = workHappened
          ? this.floorMs
          : Math.min(previousIntervalMs * this.backoffMultiplier, this.ceilingMs);
      }
      this.tickRunning = false;
      if (!this.running) return;
      if (this.forcedTickQueued || generation !== this.generation) {
        this.forcedTickQueued = false;
        this.tick(true);
        return;
      }
      this.scheduleNext();
    };

    const visit = (index: number): void => {
      if (generation !== this.generation) {
        finish();
        return;
      }
      for (let current = index; current < subscribers.length; current += 1) {
        const subscriber = subscribers[current];
        if (!subscriber) continue;
        const due =
          forced || subscriber.lastRunAt === undefined || timestamp - subscriber.lastRunAt >= subscriber.intervalMs;
        if (!due) continue;
        subscriber.lastRunAt = timestamp;
        anySubscriberRan = true;
        try {
          const result = subscriber.run();
          if (result instanceof Promise) {
            void result.then(
              (worked) => {
                if (worked) workHappened = true;
                visit(current + 1);
              },
              (error: unknown) => {
                this.onSubscriberError(subscriber.id, error);
                visit(current + 1);
              },
            );
            return;
          }
          if (result) workHappened = true;
        } catch (error) {
          this.onSubscriberError(subscriber.id, error);
        }
      }
      finish();
    };

    visit(0);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delayMs = this.currentIntervalMs ?? this.floorMs;
    this.timer = setTimeout(() => this.tick(false), delayMs);
    // A pending background poll must never be the reason the process stays
    // alive; `unref` is optional only because some test timer shims omit it.
    this.timer.unref?.();
  }
}
