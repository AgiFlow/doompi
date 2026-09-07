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
}

export interface GitWorktreesPayload {
  worktrees: WorktreeView[];
}
