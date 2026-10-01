import type { GitAuthConfig } from '../gitAuth/type';

export interface GitSyncContext {
  /** The session's checkout. */
  cwd: string;
  /** The base the session's worktree was created from, when it owns one. */
  recordedBaseRef?: string;
  /** The workspace's saved auth, read fresh for this one operation. */
  auth: GitAuthConfig;
}

export type GitSyncOutcome = { outcome: 'done' } | { outcome: 'paused'; conflicts: string[] };

export interface GitSync {
  pull(context: GitSyncContext): Promise<GitSyncOutcome>;
  /** `force` is a lease force, sent only after the reader confirmed a rejected push. */
  push(context: GitSyncContext, force: boolean): Promise<GitSyncOutcome>;
  rebase(context: GitSyncContext): Promise<GitSyncOutcome>;
  abortRebase(context: GitSyncContext): Promise<GitSyncOutcome>;
}

export interface GitSyncOptions {
  homeDir: string;
  /** The environment remote calls start from; the hub's own by default. */
  baseEnv?: NodeJS.ProcessEnv;
}
