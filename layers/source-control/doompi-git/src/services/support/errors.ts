/**
 * Expected failures, kept private to this package.
 *
 * `@agimon-ai/doompi-extension-contracts` does not export `invalidRequest` or
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
  | 'hub_unavailable'
  | 'spawn_cancelled'
  | 'registry_write_failed'
  | 'message_too_large'
  | 'git_failed';

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
