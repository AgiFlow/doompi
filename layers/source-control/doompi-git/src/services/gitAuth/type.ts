import type { GitAuthView } from '../../types/gitAuth';

/** One workspace's saved setup, token included. Never leaves the hub. */
export type GitAuthConfig =
  | { method: 'none' }
  | { method: 'ssh'; keyPath?: string }
  | { method: 'https'; host: string; username: string; token: string };

export interface GitAuthFile {
  version: 1;
  /** Keyed by the workspace's canonical root. */
  workspaces: Record<string, GitAuthConfig>;
}

export interface GitAuthStore {
  /** The workspace's setup, or `none` when it has none. */
  read(workspaceRoot: string): GitAuthConfig;
  view(workspaceRoot: string): GitAuthView;
  /** Validates and saves a browser request; throws an expected error naming what is wrong. */
  save(workspaceRoot: string, request: unknown): GitAuthView;
}

/** The environment one fetch or push runs with, and whether credentials went into it. */
export interface RemoteEnv {
  env: NodeJS.ProcessEnv;
  /** The workspace's own token or key is in this environment. */
  credentialed: boolean;
  /** Why a configured method was not applied to this remote, for an auth failure's recovery line. */
  mismatch?: string;
}
