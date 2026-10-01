import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBranchDiff } from '../../src/services/branchDiff';
import { DoomGitExpectedError } from '../../src/services/errors';
import { createGitSync } from '../../src/services/gitSync';
import type { GitSync } from '../../src/services/gitSync/type';
import { createGitSandbox, type GitSandbox } from '../support/gitSandbox';

/**
 * Pull, push and rebase against a local bare remote. Local remotes need no
 * credentials, so these cover the git sequences and the conflict and force
 * paths; the credential environment has its own proof.
 */
let sandbox: GitSandbox;
let sync: GitSync;
const NONE = { method: 'none' } as const;

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof DoomGitExpectedError ? error.code : 'unexpected';
  }
}

beforeEach(() => {
  sandbox = createGitSandbox('doompi-git-sync-');
  vi.stubEnv('GIT_CONFIG_GLOBAL', sandbox.env.GIT_CONFIG_GLOBAL!);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  sync = createGitSync({ homeDir: sandbox.root, baseEnv: sandbox.env });
});

afterEach(() => {
  vi.unstubAllEnvs();
  sandbox.dispose();
});

describe('push', () => {
  it('sets the upstream on a first push, and pushes plainly after', async () => {
    const repo = sandbox.repository('repo');
    const remote = sandbox.remote(repo, 'origin');
    sandbox.git(repo, 'checkout', '-q', '-b', 'feat/a');
    sandbox.commit(repo, 'a.txt', 'a\n', 'a');
    expect(await sync.push({ cwd: repo, auth: NONE }, false)).toEqual({ outcome: 'done' });
    expect(sandbox.git(repo, 'rev-parse', '--abbrev-ref', 'feat/a@{upstream}').trim()).toBe('origin/feat/a');

    sandbox.commit(repo, 'b.txt', 'b\n', 'b');
    await sync.push({ cwd: repo, auth: NONE }, false);
    expect(sandbox.git(remote, 'rev-parse', 'feat/a').trim()).toBe(sandbox.git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('asks before forcing after a rebase, then forces with a lease', async () => {
    const repo = sandbox.repository('repo');
    const remote = sandbox.remote(repo, 'origin');
    sandbox.git(repo, 'checkout', '-q', '-b', 'feat/r');
    sandbox.commit(repo, 'r.txt', 'r\n', 'r');
    await sync.push({ cwd: repo, auth: NONE }, false);
    const other = sandbox.clone(remote, 'other');
    sandbox.commit(other, 'main.txt', 'm\n', 'main moves');
    sandbox.git(other, 'push', '-q', 'origin', 'main');

    expect(await sync.rebase({ cwd: repo, auth: NONE })).toEqual({ outcome: 'done' });
    expect(await codeOf(sync.push({ cwd: repo, auth: NONE }, false))).toBe('push_needs_force');
    expect(await sync.push({ cwd: repo, auth: NONE }, true)).toEqual({ outcome: 'done' });
    expect(sandbox.git(remote, 'rev-parse', 'feat/r').trim()).toBe(sandbox.git(repo, 'rev-parse', 'HEAD').trim());
  });

  it('refuses a lease force over commits a background fetch picked up but this branch never integrated', async () => {
    const repo = sandbox.repository('repo');
    const remote = sandbox.remote(repo, 'origin');
    sandbox.git(repo, 'checkout', '-q', '-b', 'feat/s');
    sandbox.commit(repo, 's.txt', 's\n', 's');
    await sync.push({ cwd: repo, auth: NONE }, false);
    const other = sandbox.clone(remote, 'other');
    sandbox.git(other, 'checkout', '-q', 'feat/s');
    sandbox.commit(other, 'theirs.txt', 't\n', 'someone else pushed');
    sandbox.git(other, 'push', '-q');
    // Rewrite locally, then let an IDE-style background fetch move origin/feat/s.
    sandbox.git(repo, 'commit', '-q', '--amend', '-m', 's amended');
    sandbox.git(repo, 'fetch', '-q');

    expect(await codeOf(sync.push({ cwd: repo, auth: NONE }, true))).not.toBeUndefined();
    expect(sandbox.git(remote, 'log', '-1', '--format=%s', 'feat/s').trim()).toBe('someone else pushed');
  });
});

describe('pull and rebase', () => {
  it('pulls by rebasing local commits on top of the upstream', async () => {
    const repo = sandbox.repository('repo');
    const remote = sandbox.remote(repo, 'origin');
    const other = sandbox.clone(remote, 'other');
    sandbox.commit(other, 'remote.txt', 'r\n', 'remote');
    sandbox.git(other, 'push', '-q');
    sandbox.commit(repo, 'local.txt', 'l\n', 'local');
    expect(await sync.pull({ cwd: repo, auth: NONE })).toEqual({ outcome: 'done' });
    expect(sandbox.git(repo, 'log', '--format=%s', '-3').trim().split('\n')).toEqual(['local', 'remote', 'initial']);
  });

  it('pauses on conflicts, reports them, and aborts back to where it was', async () => {
    const repo = sandbox.repository('repo');
    const remote = sandbox.remote(repo, 'origin');
    sandbox.git(repo, 'checkout', '-q', '-b', 'feat/c');
    sandbox.commit(repo, 'README.md', '# mine\n', 'mine');
    const before = sandbox.git(repo, 'rev-parse', 'HEAD').trim();
    const other = sandbox.clone(remote, 'other');
    sandbox.commit(other, 'README.md', '# theirs\n', 'theirs');
    sandbox.git(other, 'push', '-q');

    expect(await sync.rebase({ cwd: repo, auth: NONE })).toEqual({ outcome: 'paused', conflicts: ['README.md'] });
    expect((await createBranchDiff().review(repo))?.changes.rebase).toEqual({ conflicts: ['README.md'] });
    expect(await codeOf(sync.push({ cwd: repo, auth: NONE }, false))).toBe('rebase_in_progress');

    expect(await sync.abortRebase({ cwd: repo, auth: NONE })).toEqual({ outcome: 'done' });
    expect(sandbox.git(repo, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect((await createBranchDiff().review(repo))?.changes.rebase).toBeUndefined();
  });

  it('refuses uncommitted changes, a detached HEAD, and a branch with no upstream', async () => {
    const repo = sandbox.repository('repo');
    sandbox.remote(repo, 'origin');
    fs.writeFileSync(path.join(repo, 'README.md'), 'dirty\n');
    expect(await codeOf(sync.pull({ cwd: repo, auth: NONE }))).toBe('worktree_dirty');
    expect(await codeOf(sync.rebase({ cwd: repo, auth: NONE }))).toBe('worktree_dirty');
    sandbox.git(repo, 'checkout', '-q', '--', 'README.md');

    sandbox.git(repo, 'checkout', '-q', '-b', 'loose');
    expect(await codeOf(sync.pull({ cwd: repo, auth: NONE }))).toBe('no_upstream');
    sandbox.git(repo, 'checkout', '-q', '--detach');
    expect(await codeOf(sync.push({ cwd: repo, auth: NONE }, false))).toBe('detached_head');
  });
});
