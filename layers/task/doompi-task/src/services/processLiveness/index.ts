/**
 * Is a process still running?
 *
 * Signal 0 performs the permission and existence check without delivering a
 * signal. EPERM means the process exists but belongs to another user, which
 * still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
