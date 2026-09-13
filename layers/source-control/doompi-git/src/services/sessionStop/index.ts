const POLL_MS = 100;

/**
 * Whether a process is still running.
 *
 * Signal 0 checks for existence without delivering anything. EPERM means the
 * process exists but belongs to someone else, which is still "alive" for the
 * purpose of deciding whether a worktree is in use; only ESRCH means gone.
 */
export function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Asks a session server to stop and waits for it to actually exit.
 *
 * SIGTERM rather than SIGKILL because the server treats it as a clean stop and
 * withdraws its own registry record on the way out. Waiting matters more than
 * it looks: removing a worktree while its process still holds files open is how
 * a half-removed worktree and a stale git administrative entry are made.
 *
 * Returns false on timeout rather than escalating to SIGKILL. Killing a session
 * that is slow to flush is a decision for the caller to make explicitly, not a
 * silent default buried in a helper.
 */
export async function stopSession(
  pid: number,
  timeoutMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // It exited between the check and the signal, which is the outcome we want.
    return true;
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isAlive(pid);
}
