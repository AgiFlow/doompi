/**
 * A child's own check that its parent is still there.
 *
 * WHY THIS EXISTS WHEN THE PARENT ALREADY SWEEPS AT SHUTDOWN:
 * The parent's `session_shutdown` sweep covers every case where the parent gets
 * to run code: quit, reload, `/new`, `/resume`, `/fork`. It cannot cover
 * `SIGKILL`, an OOM kill, or a host crash - no handler runs, and because every
 * child is spawned `detached: true` it is in its own process group, so the
 * terminal's Ctrl-C never reaches it either. Without this, exactly those cases
 * leave an agent running and spending tokens with nothing left to manage it.
 *
 * WHY POLLING AND NOT AN IPC CHANNEL:
 * A detached child has no inherited channel to watch, and adding one would
 * couple the child's liveness to a socket that can fail on its own. `kill(pid, 0)`
 * is the cheapest possible question and has no failure mode of its own.
 *
 * WHY IT DOES NOT JUST `process.exit`:
 * Exiting would leave the run reporting `running` forever and orphan the
 * agent's own subprocesses. The whole point is to reach the same terminal path
 * a clean stop takes, so `onParentLost` is expected to be
 * `TerminalPersistenceService.finalize()`, which persists a terminal status and
 * kills tracked children before the process goes.
 *
 * AVOID:
 * - A short interval. This is a safety net for a rare event, not a heartbeat;
 *   polling hard buys nothing and costs a syscall per child per tick
 */

const DEFAULT_INTERVAL_MS = 5_000;

export interface ParentWatchdogOptions {
  /** Pid to watch. Defaults to this process's parent. */
  parentPid?: number;
  intervalMs?: number;
  /** Liveness as a port, so a test never probes a real pid. */
  isAlive?: (pid: number) => boolean;
  /** What to do once the parent is gone. Expected to finalize and exit. */
  onParentLost: () => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Start watching. Returns a disposer.
 *
 * A `parentPid` of 1 means this process has already been reparented to init -
 * the parent is gone and nothing is coming back - so the callback fires
 * immediately rather than after one interval.
 */
export function startParentWatchdog(options: ParentWatchdogOptions): () => void {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const parentPid = options.parentPid ?? process.ppid;
  let fired = false;

  const check = (): void => {
    if (fired) return;
    if (parentPid > 1 && isAlive(parentPid)) return;
    fired = true;
    options.onParentLost();
  };

  if (parentPid <= 1) {
    check();
    return () => {};
  }

  const timer = setInterval(check, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Unref'd so this never by itself keeps a finished child alive.
  timer.unref?.();
  return () => clearInterval(timer);
}
