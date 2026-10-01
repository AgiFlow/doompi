import { describe, expect, it } from 'vitest';

import type { GitResult } from '../../../src/services/gitCli';
import { classifyGitFailure } from '../../../src/services/gitFailure';

function result(stderr: string, overrides: Partial<GitResult> = {}): GitResult {
  return { code: 128, stdout: '', stderr, timedOut: false, overflow: false, ...overrides };
}

describe('classifyGitFailure', () => {
  it.each([
    ["fatal: Authentication failed for 'https://github.com/o/r.git/'", 'auth_failed'],
    ['git@github.com: Permission denied (publickey).', 'auth_failed'],
    ["fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403", 'auth_failed'],
    ['Host key verification failed.', 'host_key_unknown'],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host_key_changed'],
    ['ERROR: Repository not found.', 'repository_not_found'],
    ['ssh: Could not resolve host: github.com', 'remote_unreachable'],
    ['error: cannot rebase: You have unstaged changes.', 'worktree_dirty'],
    ['something nobody planned for', 'git_failed'],
  ])('maps %s to %s', (stderr, code) => {
    expect(classifyGitFailure('fetch', result(stderr)).code).toBe(code);
  });

  it('reads push rejections from porcelain stdout', () => {
    expect(
      classifyGitFailure('push', result('', { stdout: '!\tHEAD:refs/heads/x\t[rejected] (non-fast-forward)\n' })).code,
    ).toBe('push_needs_force');
    expect(
      classifyGitFailure('push', result('', { stdout: '!\tHEAD:refs/heads/x\t[rejected] (stale info)\n' })).code,
    ).toBe('push_lease_rejected');
  });

  it('reports a timeout as retryable and never echoes stderr', () => {
    expect(classifyGitFailure('fetch', result('', { timedOut: true }))).toMatchObject({
      code: 'git_timeout',
      retryable: true,
    });
    const secret = "fatal: unable to access 'https://vngo:ghp_secret@github.com/o/r.git/': Could not resolve host";
    expect(classifyGitFailure('fetch', result(secret)).message).not.toContain('ghp_secret');
    expect(classifyGitFailure('fetch', result(`${secret} weird`)).message).not.toContain('github.com');
  });

  it("adds why the workspace's auth did not apply to an auth failure", () => {
    const error = classifyGitFailure(
      'push',
      result('fatal: Authentication failed'),
      "This workspace's token is for https://github.com.",
    );
    expect(error.message).toContain("This workspace's token is for https://github.com.");
    expect(error.message).toContain('git remote');
  });
});
