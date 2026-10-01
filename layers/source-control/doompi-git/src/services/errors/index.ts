/**
 * Expected failures, kept private to this package.
 *
 * `@agimon-ai/doompi-core` does not export `invalidRequest` or
 * an expected-error base, so this mirrors doompi-team's shape rather than
 * reaching across a layer boundary for it. The duplication is deliberate and
 * small; a shared helper would be the better answer only once a third package
 * needs one.
 */

export type DoomGitErrorCode =
  | 'invalid_request'
  | 'not_a_repository'
  | 'worktree_exists'
  | 'worktree_not_found'
  | 'worktree_not_owned'
  | 'worktree_peer_unavailable'
  | 'worktree_dirty'
  | 'worktree_cleanup_failed'
  | 'hub_unavailable'
  | 'spawn_cancelled'
  | 'registry_write_failed'
  | 'registry_busy'
  | 'task_delivery_failed'
  | 'message_delivery_failed'
  | 'message_too_large'
  | 'git_failed'
  // Remote auth and sync. Each carries its own recovery line; git's stderr is
  // only ever matched, never shown, because it can carry a token in a URL.
  | 'auth_failed'
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'remote_unreachable'
  | 'repository_not_found'
  | 'push_needs_force'
  | 'push_lease_rejected'
  | 'no_upstream'
  | 'no_remote'
  | 'no_base'
  | 'detached_head'
  | 'rebase_in_progress'
  | 'git_timeout';

export class DoomGitExpectedError extends Error {
  constructor(
    readonly code: DoomGitErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly recovery: string,
  ) {
    // The recovery line rides in the message because a tool result is read as
    // text: an error the model cannot act on costs a turn to rediscover.
    super(`[${code}] ${message}\nRecovery: ${recovery}`);
    this.name = 'DoomGitExpectedError';
  }
}

/** Raised when a worktree action needs the canonical hub but it is not injected. */
export class HubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnavailableError';
  }
}

export function invalidRequest(message: string, recovery: string): DoomGitExpectedError {
  return new DoomGitExpectedError('invalid_request', message, false, recovery);
}
