/**
 * Promise-based wait for a spawned child to signal that it has started.
 *
 * WHY THIS EXISTS:
 * The predecessor package waits for this same signal with `Atomics.wait`
 * (`doom-pi-subagents/src/runs/background/asyncExecution.ts:376-380`), which
 * blocks the parent's event loop for up to 10 seconds. That froze the whole TUI.
 * It was survivable when background spawns were opt-in; this package is
 * async-only, so every spawn would pay it. This module reads the same
 * readiness signal (a JSON file the child writes, `{ state: 'ready' }` or
 * `{ state: 'error', error }`) but never blocks the event loop to wait for it.
 *
 * WATCH-FIRST, POLL AS A SAFETY NET:
 * Same pattern as `PollScheduler`'s header, for the same reason: `fs.watch` is
 * the fast path, a ~20ms poll is the safety net for the platforms and mount
 * types where watches are unreliable or do not fire, and neither path is
 * trusted alone.
 *
 * WHY THIS DOES NOT REGISTER WITH `PollScheduler`:
 * `PollScheduler` exists to let background housekeeping (a handful of
 * long-lived subscribers: channel polling, status writing) back off toward
 * multi-second intervals while idle. A handshake wait is the opposite shape: a
 * per-spawn, short-lived (bounded by `timeoutMs`, default 10s), low-latency
 * wait that specifically must NOT inherit the scheduler's idle backoff. Sharing
 * the master tick would force a choice between two bad options: either every
 * concurrent handshake wait keeps the whole scheduler pinned near its floor
 * (so unrelated housekeeping never gets to back off while any spawn is
 * starting), or the handshake is checked only as often as the scheduler's
 * current backed-off interval allows (which defeats the ~20ms safety net this
 * requirement exists for). A dedicated, self-terminating timer avoids coupling
 * spawn concurrency to the cadence of unrelated background work.
 *
 * DESIGN PATTERNS:
 * - `waitForHandshake` returns `{ promise, cancel }` rather than only a promise.
 *   `cancel` is a real exit path, not a convenience: an orchestrator that sees
 *   the child process itself exit before signalling should be able to reject
 *   immediately rather than waiting out the remaining timeout doing nothing
 * - The three terminal outcomes a caller actually wants to distinguish
 *   (`signalled`, `failed`, `timed-out`) are all resolutions, not rejections,
 *   so a plain timeout does not force every caller into a try/catch. `cancel`
 *   is the one path that rejects, because it is the caller abandoning the wait
 *   for a reason of its own, not an outcome of the handshake itself
 * - One `cleanup` function is the only place that clears the timers and closes
 *   the watcher, and every terminal path (signal, failure, timeout, cancel)
 *   goes through it, so there is exactly one place a leak could be introduced
 * - Reading the handshake file behind protected seams rather than importing
 *   `node:fs` calls directly into tests: ESM module namespaces are frozen, so
 *   `vi.spyOn(fs, ...)` throws, and a seam is the documented way around that
 *
 * AVOID:
 * - Treating a JSON parse failure on the handshake file as a definite outcome;
 *   the caller writes it with a rename-based atomic write, so a failure here
 *   means this check landed mid-write, not that the child failed. It must be
 *   treated as "still pending" and retried on the next check
 * - Letting `watchDirectory` throwing propagate; a platform or mount that
 *   cannot support `fs.watch` is exactly the case the poll safety net exists
 *   for, so watch setup failing must fall through to poll-only, not abort
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Poll safety net cadence. Watches are the fast path; this bounds the worst case. */
const DEFAULT_POLL_INTERVAL_MS = 20;
/** Matches the predecessor's `RUNNER_STARTUP_TIMEOUT_MS`: this is the wire protocol's known-good bound. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SpawnHandshakeOptions {
  /** Absolute path of the file the child writes when it starts (or fails to). */
  path: string;
  /** Upper bound on how long to wait before resolving `timed-out`. Defaults to 10s. */
  timeoutMs?: number;
}

export type SpawnHandshakeOutcome =
  | { status: 'signalled' }
  | { status: 'failed'; error: string }
  | { status: 'timed-out' };

export interface SpawnHandshakeWait {
  promise: Promise<SpawnHandshakeOutcome>;
  /** Reject early and tear down. For a caller that already knows waiting further is pointless. */
  cancel: (reason: string) => void;
}

export type SpawnHandshakeContract = {
  waitForHandshake(options: SpawnHandshakeOptions): SpawnHandshakeWait;
};

/** Minimal surface this module needs from a `fs.FSWatcher`, so a test seam does not need the real type. */
interface DirectoryWatch {
  close: () => void;
}

export class SpawnHandshake implements SpawnHandshakeContract {
  /**
   * Runtime tuning seams for tests, kept out of the dependency constructor.
   */
  protected readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  protected readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS;

  protected readFile(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      // Missing (not yet written) or transiently unreadable: keep waiting.
      return undefined;
    }
  }

  /**
   * Watches the handshake file's directory, not the file itself: the file does
   * not exist yet when the wait starts, and `fs.watch` on a path that does not
   * exist throws on most platforms. Returns `undefined` when watching could not
   * be set up at all, which the caller treats as "poll-only for this wait".
   */
  protected watchDirectory(dirPath: string, onEvent: () => void): DirectoryWatch | undefined {
    try {
      const watcher = fs.watch(dirPath, () => onEvent());
      // An unhandled 'error' event on an FSWatcher crashes the process; this
      // wait has a poll safety net regardless, so a watch error just means
      // falling back to it rather than losing the wait entirely.
      watcher.on('error', () => onEvent());
      return watcher;
    } catch {
      return undefined;
    }
  }

  /** Interpret the handshake file's contents, or `undefined` when the outcome is not decided yet. */
  private readOutcome(filePath: string): SpawnHandshakeOutcome | undefined {
    const raw = this.readFile(filePath);
    if (raw === undefined) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      // A rename-based atomic write should never be readable mid-write, but a
      // torn read is cheaper to tolerate than to rule out; the next check retries.
      return undefined;
    }
    if (typeof payload !== 'object' || payload === null) return undefined;
    const state = (payload as { state?: unknown }).state;
    if (state === 'ready') return { status: 'signalled' };
    if (state === 'error') {
      const error = (payload as { error?: unknown }).error;
      return { status: 'failed', error: typeof error === 'string' ? error : 'Async runner reported an error.' };
    }
    return undefined;
  }

  waitForHandshake(options: SpawnHandshakeOptions): SpawnHandshakeWait {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let watcher: DirectoryWatch | undefined;
    let rejectWait: ((reason: unknown) => void) | undefined;

    const cleanup = (): void => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      watcher?.close();
      pollTimer = undefined;
      timeoutTimer = undefined;
      watcher = undefined;
    };

    const promise = new Promise<SpawnHandshakeOutcome>((resolve, reject) => {
      rejectWait = reject;

      const settle = (outcome: SpawnHandshakeOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      const checkNow = (): void => {
        if (settled) return;
        const outcome = this.readOutcome(options.path);
        if (outcome) settle(outcome);
      };

      timeoutTimer = setTimeout(() => settle({ status: 'timed-out' }), timeoutMs);
      timeoutTimer.unref?.();

      watcher = this.watchDirectory(path.dirname(options.path), checkNow);

      pollTimer = setInterval(checkNow, this.pollIntervalMs);
      pollTimer.unref?.();

      // The file may already exist (a very fast child, or a wait that started
      // late), so the first check happens immediately rather than waiting out
      // either the poll interval or the first watch event.
      checkNow();
    });

    const cancel = (reason: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectWait?.(new Error(reason));
    };

    return { promise, cancel };
  }
}
