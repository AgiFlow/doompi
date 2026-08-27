export interface IFileEditPaths {
  sessionKey(sessionId: string, env?: NodeJS.ProcessEnv): string;
  timelinePath(cwd: string, sessionKey: string): string;
  /** Where this session's content snapshots live, beside its timeline. */
  snapshotsPath(cwd: string, sessionKey: string): string;
}
