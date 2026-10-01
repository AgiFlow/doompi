/**
 * How doompi-git authenticates its own fetch, pull, push and rebase.
 *
 * DESIGN PATTERNS:
 * - One setup per workspace, kept outside the repository. Worktree sessions use
 *   the setup of the workspace they belong to. The agent's own git commands
 *   never see it.
 * - The token is write-only: a view says whether one is saved, never what it is.
 *
 * AVOID:
 * - Adding the token to GitAuthView. This type reaches the browser.
 */

export type GitAuthMethod = 'none' | 'ssh' | 'https';

/** What a workspace's git remote panel shows about its saved setup. */
export interface GitAuthView {
  method: GitAuthMethod;
  ssh?: { keyPath?: string };
  https?: { host: string; username: string; hasToken: boolean };
}

/**
 * What a workspace's git remote panel saves. For HTTPS an absent token keeps the saved one,
 * which is refused when the host changes, so a token never follows a host it
 * was not entered for.
 */
export type GitAuthSaveRequest =
  | { method: 'none' }
  | { method: 'ssh'; keyPath?: string }
  | { method: 'https'; host: string; username: string; token?: string };
