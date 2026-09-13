import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  gitCommonDirectory,
  repositoryId,
  repositoryLabel,
  shortId,
} from '../../../../src/services/repositoryIdentity';

let root: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(root, 'gitconfig'),
    },
  });
}

function makeRepository(name: string): string {
  const repository = path.join(root, name);
  fs.mkdirSync(repository, { recursive: true });
  git(repository, 'init', '--initial-branch=main');
  fs.writeFileSync(path.join(repository, 'README.md'), '# repo\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'initial');
  return repository;
}

beforeEach(() => {
  // Real path, so git's own absolute gitdir pointers and ours agree on macOS,
  // where the temp directory is reached through a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-identity-')));
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('gitCommonDirectory', () => {
  it('returns the .git directory of a normal checkout', () => {
    const repository = makeRepository('main-checkout');
    expect(gitCommonDirectory(repository)).toBe(path.join(repository, '.git'));
  });

  it('follows a worktree .git FILE through gitdir to the shared commondir', () => {
    // A linked worktree has a .git file, not a directory. Stopping at its own
    // admin directory would give the worktree a different identity from the
    // checkout it belongs to, and so a second, empty registry.
    const repository = makeRepository('main-checkout');
    const worktree = path.join(root, 'linked-worktree');
    git(repository, 'worktree', 'add', '-b', 'wt/one', worktree);

    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);
    expect(gitCommonDirectory(worktree)).toBe(gitCommonDirectory(repository));
  });

  it('gives a worktree and its main checkout the same repositoryId', () => {
    const repository = makeRepository('main-checkout');
    const worktree = path.join(root, 'linked-worktree');
    git(repository, 'worktree', 'add', '-b', 'wt/one', worktree);

    expect(repositoryId(worktree)).toBe(repositoryId(repository));
  });

  it('gives two different repositories different ids', () => {
    expect(repositoryId(makeRepository('one'))).not.toBe(repositoryId(makeRepository('two')));
  });

  it('returns undefined when there is no .git at all', () => {
    const plain = path.join(root, 'not-a-repo');
    fs.mkdirSync(plain);
    expect(gitCommonDirectory(plain)).toBeUndefined();
  });

  it('returns undefined for a .git file that does not point anywhere', () => {
    const odd = path.join(root, 'odd');
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, '.git'), 'not a gitdir pointer\n');
    expect(gitCommonDirectory(odd)).toBeUndefined();
  });

  it('treats a gitdir with no commondir, as a submodule has, as already common', () => {
    const submodule = path.join(root, 'submodule');
    const gitDir = path.join(root, 'parent', '.git', 'modules', 'submodule');
    fs.mkdirSync(submodule, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(submodule, '.git'), `gitdir: ${gitDir}\n`);
    expect(gitCommonDirectory(submodule)).toBe(gitDir);
  });
});

describe('repositoryId', () => {
  it('is 12 hex characters and falls back to the path outside a repository', () => {
    const plain = path.join(root, 'not-a-repo');
    fs.mkdirSync(plain);
    expect(repositoryId(plain)).toMatch(/^[0-9a-f]{12}$/u);
    expect(repositoryId(plain)).toBe(repositoryId(`${plain}${path.sep}`));
  });
});

describe('repositoryLabel', () => {
  it('lowercases and collapses everything unsafe into dashes', () => {
    expect(repositoryLabel('/tmp/My Repo.git')).toBe('my-repo-git');
    expect(repositoryLabel('/tmp/__weird__')).toBe('weird');
  });

  it('falls back to a name when nothing survives sanitising', () => {
    expect(repositoryLabel('/tmp/!!!')).toBe('repository');
  });

  it('caps the label so a directory name stays readable', () => {
    expect(repositoryLabel(`/tmp/${'a'.repeat(80)}`)).toHaveLength(32);
  });
});

describe('shortId', () => {
  it('is 8 characters, stable for a seed and different across seeds', () => {
    expect(shortId('seed')).toHaveLength(8);
    expect(shortId('seed')).toBe(shortId('seed'));
    expect(shortId('seed')).not.toBe(shortId('other'));
  });
});
