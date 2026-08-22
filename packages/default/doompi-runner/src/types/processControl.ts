/** Liveness and signalling for processes this extension did not spawn itself. */
export interface IProcessControl {
  /** True when a process with this pid is still running. */
  isAlive(pid: number): boolean;
  /**
   * Signals the whole process group led by `pid`.
   * Returns false when the group is already gone.
   */
  signalGroup(pid: number, signal: NodeJS.Signals): boolean;
}
