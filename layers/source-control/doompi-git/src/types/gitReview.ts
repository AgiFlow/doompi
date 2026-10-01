/**
 * The cockpit's view of what this session changed against its base: the counts
 * the '# diff' group shows, what the review tab lists and draws, and the manual
 * sync that sits beside them.
 *
 * DESIGN PATTERNS:
 * - Declarations only, shared by the hub and the page.
 * - Its own channel, apart from worktrees. Worktrees are repository
 *   management; the diff is this session's code change.
 * - A diff row carries one line number whose file follows from its marker: the
 *   new file's for context and additions, the old file's for removals. It is
 *   the same shape the shared DiffView draws.
 *
 * AVOID:
 * - Behaviour or node builtins. Browser code imports this file.
 */

/** The session channel carrying this checkout's changes and the sync around them. */
export const GIT_CHANGES_TYPE = 'git_changes';

/** The sync actions the review tab offers. */
export type GitSyncAction = 'pull' | 'push' | 'rebase' | 'abort-rebase';

/** What the review tab asks the hub to run. `force` only follows a confirmed rejected push. */
export type GitChangesCommand =
  | { action: 'pull' }
  | { action: 'push'; force?: true }
  | { action: 'rebase' }
  | { action: 'abort-rebase' };

export type GitSyncErrorTarget =
  | { action: 'pull' | 'rebase' | 'abort-rebase' }
  /** A push the remote rejected as non-fast-forward; the tab offers a lease force after a confirm. */
  | { action: 'push'; forceRequired?: true };

export interface GitChangesPayload {
  /** Absent outside a git checkout. */
  changes?: GitChangesView;
  /** Label of the sync command in flight. */
  pending?: string;
  /** The last sync failure, cleared when the next command starts. */
  error?: string;
  errorTarget?: GitSyncErrorTarget;
}

/** What the session changed since its base, as the '# diff' lane and the review header show it. */
export interface GitChangesView {
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
  /** The ref the changes are measured against; absent when none resolved, so only uncommitted work counts. */
  base?: string;
  added: number;
  removed: number;
  files: number;
  /** More files changed than were counted. */
  truncated?: boolean;
  /** The branch's upstream and how far apart the two are. */
  upstream?: { ref: string; ahead: number; behind: number };
  /** Present while a rebase is paused on conflicts. */
  rebase?: { conflicts: string[] };
}

export type GitReviewFileStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'conflicted';

/** One changed file in the review list. */
export interface GitReviewFileEntry {
  /** Repository-relative, forward slashes. */
  path: string;
  status: GitReviewFileStatus;
  added: number;
  removed: number;
  binary?: boolean;
}

/** The review tab's file list. */
export interface GitReviewSummary {
  /** False when the session's directory is not a git checkout. */
  repository: boolean;
  branch?: string;
  base?: string;
  /** Short sha of the commit the diff starts from. */
  mergeBase?: string;
  files: GitReviewFileEntry[];
  truncated?: boolean;
}

export interface GitDiffRow {
  marker: '+' | '-' | ' ';
  line: number;
  content: string;
}

export interface GitDiffHunk {
  start: number;
  rows: GitDiffRow[];
}

/** One file's hunks, fetched when the reader expands it. */
export interface GitReviewFileDiff {
  path: string;
  hunks: GitDiffHunk[];
  binary?: true;
  /** The diff was past the size cap and is not drawn. */
  tooLarge?: true;
}
