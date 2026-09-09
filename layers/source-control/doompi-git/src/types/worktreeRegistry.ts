/**
 * The worktree registry: what this package knows about the worktrees it made.
 *
 * It deliberately does not mirror `git worktree list`. Git knows which
 * worktrees exist; only this registry knows which of them this package created,
 * which session runs in each, and which process to signal. Reconciling the two
 * is how orphans are found, so the two views are kept separate on purpose.
 */

/**
 * A worktree's lifecycle as this package sees it.
 *
 * `orphaned` is a finding, not a cleanup: the session process is gone or the
 * directory has vanished, but the worktree may still hold uncommitted work, so
 * the record is kept until someone decides what to do with it.
 */
export type WorktreeStatus = 'spawning' | 'running' | 'closing' | 'orphaned';

export const WORKTREE_RECORD_VERSION = 1;

export interface WorktreeRecord {
  version: typeof WORKTREE_RECORD_VERSION;
  /** This registry's own id, distinct from the session id, and stable across restarts. */
  id: string;
  /** The branch checked out in the worktree. */
  branch: string;
  /** The ref the branch was created from, kept so a merge can name its base. */
  baseRef: string;
  /** Absolute path to the worktree directory. */
  path: string;
  /** Absolute path to the repository the worktree belongs to. */
  repositoryRoot: string;
  /** The session spawned into the worktree. */
  sessionId: string;
  /** The session that asked for the worktree; the rail nests one under the other. */
  parentSessionId: string;
  status: WorktreeStatus;
  /** ISO 8601. */
  createdAt: string;
}

export interface WorktreeRegistryFile {
  version: typeof WORKTREE_RECORD_VERSION;
  entries: readonly WorktreeRecord[];
}

/** Reads the registry back, treating anything unusable as an empty registry. */
export interface WorktreeRegistryStore {
  list(): WorktreeRecord[];
  /** Replaces the whole file. One writer per repository, so no merge is attempted. */
  replace(entries: readonly WorktreeRecord[]): void;
}

/** The git operations this package needs, named in its own vocabulary. */
export interface WorktreeGit {
  addWorktree(input: { repositoryRoot: string; path: string; branch: string; baseRef: string }): Promise<void>;
  removeWorktree(input: { repositoryRoot: string; path: string; force: boolean }): Promise<void>;
  /**
   * Safe branch delete, reporting refusal rather than throwing.
   *
   * `worktree remove` leaves the branch behind, so undoing a spawn needs this
   * too. It is always the safe form: git refuses a branch holding unmerged
   * work, and false says the branch is still there rather than pretending it
   * went.
   */
  deleteBranch(input: { repositoryRoot: string; branch: string }): Promise<boolean>;
  pruneWorktrees(repositoryRoot: string): Promise<void>;
  /** Paths git currently lists for the repository, used to find orphans. */
  listWorktreePaths(repositoryRoot: string): Promise<string[]>;
  /** Files with uncommitted changes, empty when the tree is clean. */
  dirtyFiles(path: string): Promise<string[]>;
  /** The repository root for a directory, or undefined when it is not a repository. */
  repositoryRoot(cwd: string): Promise<string | undefined>;
  /** The branch currently checked out, used as the default base ref. */
  currentBranch(cwd: string): Promise<string | undefined>;
  /** Merges a worktree's branch into whatever the given root has checked out. */
  mergeBranch(input: { repositoryRoot: string; branch: string; message?: string }): Promise<void>;
}
