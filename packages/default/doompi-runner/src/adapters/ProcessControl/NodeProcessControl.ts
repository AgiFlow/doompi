import type { IProcessControl } from '../../types/processControl';

const LIVENESS_PROBE = 0;

/** Wraps `process.kill`, which doubles as the liveness probe on POSIX. */
export class NodeProcessControl implements IProcessControl {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, LIVENESS_PROBE);
      return true;
    } catch {
      // EPERM would also land here, but a process we cannot signal is not one
      // this extension can manage, so treating it as gone is the safe answer.
      return false;
    }
  }

  signalGroup(pid: number, signal: NodeJS.Signals): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
