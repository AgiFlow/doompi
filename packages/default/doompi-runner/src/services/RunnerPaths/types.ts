export interface LogSweepResult {
  removed: string[];
  errors: string[];
}

/** Filesystem layout for runner state, scoped to one Pi session. */
export interface IRunnerPaths {
  /** Worktree root, used as the registry scope key. */
  repositoryPath(): string;
  /** Adopt the Pi session before the extension reads or writes runner state. */
  setSessionId(sessionId: string): void;
  /** Directory holding one session's runner logs. */
  logDirectory(sessionId?: string): string;
  /** Directory holding one session's persistent metadata for CLI access. */
  stateDirectory(sessionId?: string): string;
  logPathFor(id: string, sessionId?: string): string;
  /** Legacy rotation path retained for cleanup and executable compatibility. */
  rotatedLogPathFor(id: string, sessionId?: string): string;
  statePathFor(id: string, sessionId?: string): string;
  ensureDirectories(sessionId?: string): void;
  /**
   * Deletes completed metadata and matching logs after the retention window.
   * Running records are never removed.
   */
  sweepHistory(ttlMs: number, now?: number): LogSweepResult;
  /** Async startup-safe form of history retention cleanup. */
  sweepHistoryAsync?(ttlMs: number, now?: number): Promise<LogSweepResult>;
  /** Exact legacy Git-directory store, if this repository has one. */
  legacyDirectory(): string | undefined;
  /** Removes only the validated legacy doom-runner directory. */
  removeLegacyStore(): string | undefined;
}
