/**
 * Debounced grouping for successful completion notifications.
 *
 * WHY THIS EXISTS:
 * A fan-out run's children tend to finish within milliseconds of each other.
 * Notifying once per child turns a five-way parallel run into five separate
 * interruptions for the operator instead of one. This holds a *successful*
 * completion briefly so siblings finishing in the same short window arrive as
 * a single grouped message.
 *
 * DESIGN PATTERNS (ported as-is from
 * `doom-pi-subagents/src/runs/background/completionBatcher.ts` - this
 * module's logic was not one of the flagged predecessor bugs):
 * - A hard `maxWaitMs` cap, measured from the first item in the group, means
 *   a debounce that keeps getting reset by new arrivals cannot hold a group
 *   open forever
 * - After a group emits, arrivals within `stragglerWindowMs` join a shorter
 *   "straggler" group (`stragglerDebounceMs`/`stragglerMaxWaitMs`): a single
 *   slow sibling still gets grouped with whoever else trails in soon after,
 *   rather than waiting out the full debounce alone
 * - `push()` is the only entry point that arms timers; `flush()` and
 *   `dispose()` both go through the same `clearTimers`/emit path, so there is
 *   one place a leak could be introduced
 * - Disabled mode (`config.enabled === false`) degrades to "emit immediately,
 *   one item at a time" rather than a special code path elsewhere: every
 *   caller of `push()` behaves the same regardless of whether batching is on
 *
 * WHY THIS OWNS ITS OWN TIMERS RATHER THAN REGISTERING WITH `PollScheduler`:
 * Same reasoning as `spawnHandshake.ts`'s documented exception, and for the
 * same underlying reason: `PollScheduler`'s floor is 200ms, and this
 * batcher's default `debounceMs` is 150ms - below the floor before backoff
 * even starts growing it. Coupling a sub-200ms debounce to a shared tick that
 * is explicitly designed to back off toward 5s while idle would make the
 * debounce it exists to provide unreliable. A completion batcher is also
 * short-lived and per-group (bounded by `maxWaitMs`, at most ~1s), the same
 * shape as a handshake wait, not a long-lived background subscriber.
 *
 * AVOID:
 * - Calling `push()` for a failed or paused completion; this batcher has no
 *   opinion on what should bypass it; that decision belongs to the caller
 *   (`notify.ts`), which flushes and emits those immediately instead
 */

export interface CompletionBatchConfig {
  enabled?: boolean;
  /** Idle window after each arrival; resets on every new item. */
  debounceMs?: number;
  /** Hard cap measured from the first item in a group. */
  maxWaitMs?: number;
  /** Shorter idle window for straggler groups. */
  stragglerDebounceMs?: number;
  /** Shorter hard cap for straggler groups. */
  stragglerMaxWaitMs?: number;
  /** Arrivals within this window after an emit join a straggler group. */
  stragglerWindowMs?: number;
}

export interface ResolvedCompletionBatchConfig {
  enabled: boolean;
  debounceMs: number;
  maxWaitMs: number;
  stragglerDebounceMs: number;
  stragglerMaxWaitMs: number;
  stragglerWindowMs: number;
}

export const DEFAULT_COMPLETION_BATCH_CONFIG: ResolvedCompletionBatchConfig = {
  enabled: true,
  debounceMs: 150,
  maxWaitMs: 1000,
  stragglerDebounceMs: 75,
  stragglerMaxWaitMs: 400,
  stragglerWindowMs: 2000,
};

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

export function resolveCompletionBatchConfig(override?: CompletionBatchConfig): ResolvedCompletionBatchConfig {
  return {
    enabled: typeof override?.enabled === 'boolean' ? override.enabled : DEFAULT_COMPLETION_BATCH_CONFIG.enabled,
    debounceMs: parsePositiveInt(override?.debounceMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.debounceMs,
    maxWaitMs: parsePositiveInt(override?.maxWaitMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.maxWaitMs,
    stragglerDebounceMs:
      parsePositiveInt(override?.stragglerDebounceMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.stragglerDebounceMs,
    stragglerMaxWaitMs:
      parsePositiveInt(override?.stragglerMaxWaitMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.stragglerMaxWaitMs,
    stragglerWindowMs:
      parsePositiveInt(override?.stragglerWindowMs) ?? DEFAULT_COMPLETION_BATCH_CONFIG.stragglerWindowMs,
  };
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerApi {
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface CompletionBatcherOptions<T> {
  config: ResolvedCompletionBatchConfig;
  emit: (items: T[]) => void;
  timers?: TimerApi;
  now?: () => number;
}

export interface CompletionBatcher<T> {
  /** Add a batchable item. Emits immediately, alone, when batching is disabled. */
  push(item: T): void;
  /** Emit any held items immediately as a single group. No-op when nothing is held. */
  flush(): void;
  /** Clear timers and return items that were never emitted, without emitting them. */
  dispose(): T[];
}

/**
 * Create a completion batcher. Single-use per registration: it holds at most
 * one open group at a time. `flush()` forces emission (used by the caller to
 * drain a group before an immediate, unbatched emit for a failure/pause);
 * `dispose()` tears down timers for reload/shutdown without emitting.
 */
export function createCompletionBatcher<T>(options: CompletionBatcherOptions<T>): CompletionBatcher<T> {
  const timers = options.timers ?? defaultTimers;
  const now = options.now ?? Date.now;
  const config = options.config;

  if (!config.enabled) {
    return {
      push(item: T) {
        options.emit([item]);
      },
      flush() {
        /* nothing is ever held when disabled */
      },
      dispose() {
        return [];
      },
    };
  }

  let pending: T[] = [];
  let debounceTimer: TimerHandle | undefined;
  let maxWaitTimer: TimerHandle | undefined;
  let straggler = false;
  let lastEmitAt: number | undefined;

  const clearTimers = (): void => {
    if (debounceTimer !== undefined) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (maxWaitTimer !== undefined) {
      timers.clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }
  };

  const emitGroup = (): void => {
    clearTimers();
    if (pending.length === 0) return;
    const items = pending;
    pending = [];
    lastEmitAt = now();
    options.emit(items);
  };

  return {
    push(item: T) {
      if (pending.length === 0) {
        straggler = lastEmitAt !== undefined && now() - lastEmitAt < config.stragglerWindowMs;
      }
      pending.push(item);

      if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
      const debounceDelay = straggler ? config.stragglerDebounceMs : config.debounceMs;
      debounceTimer = timers.setTimeout(emitGroup, debounceDelay);
      debounceTimer.unref?.();

      if (maxWaitTimer === undefined) {
        const maxWaitDelay = straggler ? config.stragglerMaxWaitMs : config.maxWaitMs;
        maxWaitTimer = timers.setTimeout(emitGroup, maxWaitDelay);
        maxWaitTimer.unref?.();
      }
    },
    flush: emitGroup,
    dispose() {
      clearTimers();
      const abandoned = pending;
      pending = [];
      return abandoned;
    },
  };
}
