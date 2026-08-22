export interface IFileEditPaths {
  sessionKey(sessionId: string, env?: NodeJS.ProcessEnv): string;
  timelinePath(cwd: string, sessionKey: string): string;
}
