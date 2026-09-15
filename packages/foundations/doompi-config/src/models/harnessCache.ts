import type { HarnessState } from '../types/config';

export interface LoadedHarnessState {
  /** Undefined when this process is running off the environment fallback. */
  filePath?: string;
  owned: boolean;
  state: HarnessState;
}

export interface CachedHarnessState extends LoadedHarnessState {
  /** The file's mtime when it was read, so a rewrite by another copy is noticed. */
  mtimeMs?: number;
}

export const harnessCache: { loaded: CachedHarnessState | undefined } = { loaded: undefined };
