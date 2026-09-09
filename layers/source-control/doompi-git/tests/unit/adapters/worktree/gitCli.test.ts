import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeGit } from '../../../../src/adapters/worktree/gitCli.ts';
import type { WorktreeGit } from '../../../../src/types/worktreeRegistry.ts';

let root: string;
let repository: string;
let worktreeGit: WorktreeGit;

/** Runs git against the real binary, isolated from whatever the machine configures. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(root, 'gitconfig'),
    },
  });
}

function makeRepository(name: string): string {
  const created = path.join(root, name);
  fs.mkdirSync(created, { recursive: true });
  git(created, 'init', '--initial-branch=main');
  // Local identity, so a clean machine with no global git config can commit.
  git(created, 'config', 'user.email', 'test@example.com');
  git(created, 'config', 'user.name', 'Test');
  // The adapter runs git with the ambient environment, so a machine-wide
  // signing default would otherwise decide whether these commits work.
  git(created, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(created, 'README.md'), '# repo\n');
  git(created, 'add', '.');
  git(created, 'commit', '-m', 'initial');
  return created;
}

function commit(cwd: string, file: string, contents: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), contents);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', message);
}

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to reject');
}

beforeEach(() => {
  // Real path, so git's absolute answers and ours agree on macOS, where the
  // temp directory is reached through a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-cli-')));
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
  repository = makeRepository('main-checkout');
  worktreeGit = createWorktreeGit();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('addWorktree', () => {
  it('creates a worktree on a new branch from the base ref', async () => {
    const worktree = path.join(root, 'wt-one');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/one', baseRef: 'main' });

    expect(fs.existsSync(path.join(worktree, 'README.md'))).toBe(true);
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('wt/one');
  });

  it('fails when the branch already exists, naming only the exit code and the size of stderr', async () => {
    const first = path.join(root, 'wt-first');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: first, branch: 'wt/dup', baseRef: 'main' });

    const error = await caught(() =>
      worktreeGit.addWorktree({
        repositoryRoot: repository,
        path: path.join(root, 'wt-second'),
        branch: 'wt/dup',
        baseRef: 'main',
      }),
    );

    expect(error.message).toMatch(/^git worktree add failed \(exit \d+, \d+ bytes of stderr\)$/u);
    // The exact code is git's, not ours; only that a code is reported matters.
    expect(error.message).not.toContain('exit 0');
    // Raw stderr never travels: it can carry a remote URL with a token in it.
    expect(error.message).not.toMatch(/already exists/u);
    expect(error.message).not.toMatch(/fatal/iu);
    expect(error.message).not.toMatch(/wt\/dup/u);
  });
});

describe('deleteBranch', () => {
  it('deletes a branch that holds nothing the base ref does not', async () => {
    const worktree = path.join(root, 'wt-del');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/del', baseRef: 'main' });
    await worktreeGit.removeWorktree({ repositoryRoot: repository, path: worktree, force: true });

    expect(await worktreeGit.deleteBranch({ repositoryRoot: repository, branch: 'wt/del' })).toBe(true);
    expect(git(repository, 'branch', '--list', 'wt/del').trim()).toBe('');
  });

  // The whole safety property: a rollback must never take commits with it.
  it('refuses a branch holding unmerged work, and says so by returning false', async () => {
    const worktree = path.join(root, 'wt-keep');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/keep', baseRef: 'main' });
    commit(worktree, 'kept.md', '# kept\n', 'work in the worktree');
    await worktreeGit.removeWorktree({ repositoryRoot: repository, path: worktree, force: true });

    expect(await worktreeGit.deleteBranch({ repositoryRoot: repository, branch: 'wt/keep' })).toBe(false);
    expect(git(repository, 'branch', '--list', 'wt/keep').trim()).toContain('wt/keep');
  });
});
describe('removeWorktree', () => {
  it('removes a clean worktree', async () => {
    const worktree = path.join(root, 'wt-clean');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/clean', baseRef: 'main' });

    await worktreeGit.removeWorktree({ repositoryRoot: repository, path: worktree, force: false });

    expect(fs.existsSync(worktree)).toBe(false);
    expect(git(repository, 'worktree', 'list', '--porcelain')).not.toContain(worktree);
  });

  it('is idempotent when the directory was deleted behind git\u2019s back', async () => {
    const worktree = path.join(root, 'wt-vanished');
    await worktreeGit.addWorktree({
      repositoryRoot: repository,
      path: worktree,
      branch: 'wt/vanished',
      baseRef: 'main',
    });
    fs.rmSync(worktree, { recursive: true, force: true });

    await expect(
      worktreeGit.removeWorktree({ repositoryRoot: repository, path: worktree, force: false }),
    ).resolves.toBeUndefined();

    // The administrative entry has to be gone too, or a retry at the same path refuses.
    await expect(
      worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/again', baseRef: 'main' }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(worktree, 'README.md'))).toBe(true);
  });

  it('still fails for a path that was never a worktree and is still on disk', async () => {
    const plain = path.join(root, 'not-a-worktree');
    fs.mkdirSync(plain);

    const error = await caught(() =>
      worktreeGit.removeWorktree({ repositoryRoot: repository, path: plain, force: false }),
    );

    expect(error.message).toMatch(/^git worktree remove failed \(exit \d+, \d+ bytes of stderr\)$/u);
    expect(error.message).not.toMatch(/not a working tree/u);
    expect(fs.existsSync(plain)).toBe(true);
  });

  it('removes a dirty worktree when forced', async () => {
    const worktree = path.join(root, 'wt-dirty');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/dirty', baseRef: 'main' });
    fs.writeFileSync(path.join(worktree, 'README.md'), 'edited\n');

    await expect(
      worktreeGit.removeWorktree({ repositoryRoot: repository, path: worktree, force: true }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(worktree)).toBe(false);
  });
});

describe('listWorktreePaths', () => {
  it('returns the main checkout plus every added worktree', async () => {
    const one = path.join(root, 'wt-list-one');
    const two = path.join(root, 'wt-list-two');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: one, branch: 'wt/list-one', baseRef: 'main' });
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: two, branch: 'wt/list-two', baseRef: 'main' });

    await expect(worktreeGit.listWorktreePaths(repository)).resolves.toEqual([repository, one, two]);
  });

  it('returns nothing rather than throwing outside a repository', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    await expect(worktreeGit.listWorktreePaths(plain)).resolves.toEqual([]);
  });
});

describe('dirtyFiles', () => {
  it('is empty for a clean tree', async () => {
    await expect(worktreeGit.dirtyFiles(repository)).resolves.toEqual([]);
  });

  it('names modified and untracked files', async () => {
    fs.writeFileSync(path.join(repository, 'README.md'), '# changed\n');
    fs.writeFileSync(path.join(repository, 'scratch.txt'), 'new\n');

    await expect(worktreeGit.dirtyFiles(repository)).resolves.toEqual(
      expect.arrayContaining(['README.md', 'scratch.txt']),
    );
    await expect(worktreeGit.dirtyFiles(repository)).resolves.toHaveLength(2);
  });
});

describe('repositoryRoot', () => {
  it('returns the top level from inside the checkout', async () => {
    const nested = path.join(repository, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    await expect(worktreeGit.repositoryRoot(nested)).resolves.toBe(repository);
  });

  it('returns undefined outside a repository', async () => {
    const plain = path.join(root, 'outside');
    fs.mkdirSync(plain);
    await expect(worktreeGit.repositoryRoot(plain)).resolves.toBeUndefined();
  });
});

describe('currentBranch', () => {
  it('returns the checked-out branch of the checkout and of a worktree', async () => {
    const worktree = path.join(root, 'wt-branch');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/branch', baseRef: 'main' });

    await expect(worktreeGit.currentBranch(repository)).resolves.toBe('main');
    await expect(worktreeGit.currentBranch(worktree)).resolves.toBe('wt/branch');
  });

  it('returns undefined outside a repository', async () => {
    const plain = path.join(root, 'no-branch');
    fs.mkdirSync(plain);
    await expect(worktreeGit.currentBranch(plain)).resolves.toBeUndefined();
  });
});

describe('mergeBranch', () => {
  it('merges a worktree branch back and keeps the merge identifiable', async () => {
    const worktree = path.join(root, 'wt-merge');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/merge', baseRef: 'main' });
    commit(worktree, 'feature.txt', 'from the worktree\n', 'add feature');

    await expect(
      worktreeGit.mergeBranch({ repositoryRoot: repository, branch: 'wt/merge', message: 'merge wt/merge' }),
    ).resolves.toBeUndefined();

    expect(fs.readFileSync(path.join(repository, 'feature.txt'), 'utf8')).toBe('from the worktree\n');
    // --no-ff on purpose: the worktree's work stays a unit, so HEAD has two parents.
    const parents = git(repository, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
    expect(parents).toHaveLength(3);
    expect(git(repository, 'log', '-1', '--pretty=%s').trim()).toBe('merge wt/merge');
  });

  it('fails on a real conflict without leaking stderr', async () => {
    const worktree = path.join(root, 'wt-conflict');
    await worktreeGit.addWorktree({
      repositoryRoot: repository,
      path: worktree,
      branch: 'wt/conflict',
      baseRef: 'main',
    });
    commit(worktree, 'README.md', '# worktree side\n', 'worktree edit');
    commit(repository, 'README.md', '# checkout side\n', 'checkout edit');

    const error = await caught(() =>
      worktreeGit.mergeBranch({ repositoryRoot: repository, branch: 'wt/conflict', message: 'merge wt/conflict' }),
    );

    expect(error.message).toMatch(/^git merge failed \(exit \d+, \d+ bytes of stderr\)$/u);
    expect(error.message).not.toMatch(/conflict/iu);
    expect(error.message).not.toMatch(/README/u);
  });
});

describe('pruneWorktrees', () => {
  it('drops the administrative entry for a directory that is gone', async () => {
    const worktree = path.join(root, 'wt-prune');
    await worktreeGit.addWorktree({ repositoryRoot: repository, path: worktree, branch: 'wt/prune', baseRef: 'main' });
    fs.rmSync(worktree, { recursive: true, force: true });

    await worktreeGit.pruneWorktrees(repository);

    await expect(worktreeGit.listWorktreePaths(repository)).resolves.toEqual([repository]);
  });
});
