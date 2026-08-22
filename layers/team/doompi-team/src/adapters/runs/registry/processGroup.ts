/**
 * Stopping a run's whole process tree.
 *
 * Every child is spawned `detached: true`, which puts it in its own process
 * group, which is what makes `kill(-pid)` reach the agent AND whatever it
 * spawned. Signalling the pid alone would leave a CLI's own subprocesses
 * running after their parent died.
 *
 * WHY SIGTERM THEN SIGKILL, RATHER THAN EITHER ALONE:
 * SIGTERM lets a runner finalize - persist its terminal status, release its
 * team membership, kill its own children. SIGKILL cannot be caught, so a runner
 * that is wedged still goes away. Doing only the first leaves a hung child
 * running; doing only the second guarantees a stale `running` status on disk.
 *
 * `doom-runner` does the same thing at `services/Launcher/Launcher.ts`, and Pi
 * itself at `utils/shell.ts`'s `killProcessTree`. Neither is importable from
 * here - Pi exports only `getShellConfig` from that module - so this is a third
 * copy of a nine-line idea rather than a shared dependency.
 *
 * AVOID:
 * - Signalling `pid` instead of `-pid`; that misses the group
 */

const DEFAULT_GRACE_MS = 3_000;

export interface ProcessGroupSignals {
  /** Send `signal` to the group led by `pid`. Returns false when it is already gone. */
  signalGroup(pid: number, signal: NodeJS.Signals): boolean;
  isAlive(pid: number): boolean;
  wait(ms: number): Promise<void>;
}

export const nodeProcessGroupSignals: ProcessGroupSignals = {
  signalGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // ESRCH: already gone, which is the outcome we wanted. EPERM: not ours to
      // signal, and retrying with SIGKILL will not change that.
      return false;
    }
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  },
};

/**
 * Stop one run's process group, escalating if it outlasts the grace period.
 *
 * Resolves `true` once nothing in the group is alive, `false` if something
 * survived even SIGKILL - which should be impossible on POSIX and is reported
 * rather than asserted, because a caller sweeping many runs needs to know which
 * one it could not clear.
 */
export async function stopProcessGroup(
  pid: number,
  graceMs: number = DEFAULT_GRACE_MS,
  signals: ProcessGroupSignals = nodeProcessGroupSignals,
): Promise<boolean> {
  if (!signals.isAlive(pid)) return true;
  signals.signalGroup(pid, 'SIGTERM');
  await signals.wait(graceMs);
  if (!signals.isAlive(pid)) return true;
  signals.signalGroup(pid, 'SIGKILL');
  await signals.wait(graceMs);
  return !signals.isAlive(pid);
}
