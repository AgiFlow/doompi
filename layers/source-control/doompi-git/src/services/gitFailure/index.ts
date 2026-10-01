import { DoomGitExpectedError, type DoomGitErrorCode } from '../errors';
import { SETTINGS_HINT } from '../gitAuth';
import type { GitResult } from '../gitCli';

/**
 * Turns a failed remote git call into an expected error a reader can act on.
 *
 * git's stderr is matched and then dropped. It never reaches a message, a
 * notice or a tool result, because a remote URL in it can carry a token. LC_ALL
 * is pinned to C by the runner, so these English phrases are the ones git
 * prints. Order matters: a 401 also says "unable to access", and auth must win.
 */

interface Rule {
  code: DoomGitErrorCode;
  phrases: readonly string[];
  message: string;
  recovery: string;
  retryable: boolean;
}

const RULES: readonly Rule[] = [
  {
    code: 'host_key_changed',
    phrases: ['remote host identification has changed'],
    message: "The remote's SSH host key changed since this machine last saw it.",
    recovery: 'Check with the host that the change is expected, then update ~/.ssh/known_hosts from a terminal.',
    retryable: false,
  },
  {
    code: 'host_key_unknown',
    phrases: ['host key verification failed', 'no ed25519 host key is known', 'no rsa host key is known'],
    message: "This machine does not trust the remote's SSH host key yet.",
    recovery: 'Run `ssh -T git@<host>` once in a terminal and accept the key, then try again.',
    retryable: false,
  },
  {
    code: 'auth_failed',
    phrases: [
      'authentication failed',
      'could not read username',
      'could not read password',
      'permission denied (publickey',
      'returned error: 401',
      'returned error: 403',
      'terminal prompts disabled',
      'load key',
      'unprotected private key',
      'invalid format',
    ],
    message: 'The remote refused the credentials.',
    recovery: `Check this workspace's git remote auth. ${SETTINGS_HINT}`,
    retryable: false,
  },
  {
    code: 'repository_not_found',
    phrases: ['repository not found', 'does not appear to be a git repository'],
    message: 'The remote repository was not found, or these credentials cannot see it.',
    recovery: `Check the remote URL and that the credentials have access. ${SETTINGS_HINT}`,
    retryable: false,
  },
  {
    code: 'remote_unreachable',
    phrases: [
      'could not resolve host',
      'connection refused',
      'connection timed out',
      'operation timed out',
      'unable to access',
      'network is unreachable',
    ],
    message: 'The remote could not be reached.',
    recovery: 'Check the network and the remote URL, then try again.',
    retryable: true,
  },
  {
    code: 'push_lease_rejected',
    phrases: ['(stale info)'],
    message: 'The remote branch moved since your last fetch, so the force push was refused.',
    recovery: 'Pull to see the new commits, then decide whether to push again.',
    retryable: false,
  },
  {
    code: 'push_needs_force',
    phrases: ['(non-fast-forward)', '(fetch first)'],
    message: 'The remote branch has commits yours replaced, usually after a rebase.',
    recovery: 'Confirm a force push with lease, or pull first to keep the remote commits.',
    retryable: false,
  },
  {
    code: 'worktree_dirty',
    phrases: [
      'unstaged changes',
      'uncommitted changes',
      'would be overwritten',
      'your index contains uncommitted changes',
    ],
    message: 'There are uncommitted changes in the way.',
    recovery: 'Commit or stash your changes first.',
    retryable: false,
  },
];

export function classifyGitFailure(operation: string, result: GitResult, mismatch?: string): DoomGitExpectedError {
  if (result.timedOut) {
    return new DoomGitExpectedError(
      'git_timeout',
      `git ${operation} took too long and was stopped.`,
      true,
      'Check the network, then try again.',
    );
  }
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const rule = RULES.find((candidate) => candidate.phrases.some((phrase) => text.includes(phrase)));
  if (rule === undefined) {
    return new DoomGitExpectedError(
      'git_failed',
      `git ${operation} failed (exit ${String(result.code)}).`,
      false,
      'Run the same command in a terminal in this checkout to see what git says.',
    );
  }
  const recovery =
    rule.code === 'auth_failed' && mismatch !== undefined ? `${mismatch} ${rule.recovery}` : rule.recovery;
  return new DoomGitExpectedError(rule.code, rule.message, rule.retryable, recovery);
}
