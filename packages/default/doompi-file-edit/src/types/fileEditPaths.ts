export interface IFileEditPaths {
  sessionKey(sessionId: string, env?: NodeJS.ProcessEnv): string;
  timelinePath(cwd: string, sessionKey: string): string;
  /** Where this session's content snapshots live, beside its timeline. */
  snapshotsPath(cwd: string, sessionKey: string): string;
  /**
   * The directory every session's state shares. A sweep has to read it, and the
   * paths for one session cannot name it on their own.
   */
  stateDirectory(): string;
  /**
   * Where a build before this one kept the same state, or undefined when there
   * is nowhere. Only a repository answers, because the old layout wrote into
   * the git common directory and nowhere else.
   */
  legacyStateDirectory(cwd: string): string | undefined;
}
