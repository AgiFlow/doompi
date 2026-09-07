/**
 * The cockpit's view of this session's worktrees.
 *
 * DESIGN PATTERNS:
 * - Declarations only. The channel frame type is a constant so the hub and the
 *   page cannot drift apart on a string.
 * - A view is the subset of a record the dock needs, not the record. The
 *   registry may hold paths and provenance the page has no business rendering.
 *
 * AVOID:
 * - Adding behaviour here. This file is imported by browser code, so it must
 *   stay free of node builtins.
 */

/** The data channel carrying one session's worktrees to the page. */
export const GIT_WORKTREES_TYPE = 'git_worktrees';

/** One worktree, as the activity dock and its panel render it. */
export interface WorktreeView {
  id: string;
  branch: string;
  path: string;
  /** The session the hub started for this worktree, when it is still live. */
  sessionId: string | null;
  /** True once the directory the record names has gone missing. */
  orphaned: boolean;
  /**
   * True when the session that asked for this worktree is gone.
   *
   * An owned worktree is only ever shown to its own session. This flag marks
   * the exception: once the parent is dead nobody would see the worktree at
   * all, so every session in the repository does, and may close it.
   */
  unowned: boolean;
}

/**
 * What the panel asks the hub channel to do.
 *
 * The dock acts through its own channel rather than through the agent: a
 * worktree made from the panel and one made by the tool take the same
 * `worktreeOperations` path, but the panel no longer has to spend a turn of
 * the conversation to get there.
 */
export type GitWorktreesCommand =
  | { action: 'create'; branch: string; baseRef?: string }
  | { action: 'close'; id: string; force?: boolean };

export interface GitWorktreesPayload {
  worktrees: WorktreeView[];
  /** Label of the operation in flight, absent when the session is idle. */
  pending?: string;
  /** The last failure, cleared when the next command starts. */
  error?: string;
}
