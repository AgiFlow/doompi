import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSkillCacheDirectory, sanitizeSyncLabel } from '../../src/adapters/skillCacheLocation.ts';

describe('resolveSkillCacheDirectory', () => {
  let workspace: string;
  let home: string;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'domain-cache-')));
    home = path.join(workspace, 'home');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('lands under the home-scoped sync namespace, keyed by repository and worktree', () => {
    const root = path.join(workspace, 'my repo');
    fs.mkdirSync(root, { recursive: true });

    const directory = resolveSkillCacheDirectory(root, home);

    expect(directory.startsWith(path.join(home, '.pi', '.doom', 'sync'))).toBe(true);
    expect(directory.endsWith(path.join('cache', 'skills'))).toBe(true);
    expect(directory).toContain('my-repo--');
    expect(directory.split(path.sep)).toContain('worktrees');
  });

  it('gives two worktrees of one repository the same repository segment and different worktrees', () => {
    const main = path.join(workspace, 'main');
    const linked = path.join(workspace, 'linked');
    const gitDirectory = path.join(main, '.git');
    const worktreeGit = path.join(gitDirectory, 'worktrees', 'linked');
    fs.mkdirSync(worktreeGit, { recursive: true });
    fs.mkdirSync(linked, { recursive: true });
    fs.writeFileSync(path.join(worktreeGit, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${worktreeGit}\n`);

    const [mainRepo, mainWorktree] = repositoryAndWorktree(resolveSkillCacheDirectory(main, home));
    const [linkedRepo, linkedWorktree] = repositoryAndWorktree(resolveSkillCacheDirectory(linked, home));

    expect(linkedRepo).toBe(mainRepo);
    expect(linkedWorktree).not.toBe(mainWorktree);
  });

  it('resolves a checkout reached through a symlink to the same identity', () => {
    const root = path.join(workspace, 'repo');
    const alias = path.join(workspace, 'alias');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(root, alias);

    expect(resolveSkillCacheDirectory(alias, home)).toBe(resolveSkillCacheDirectory(root, home));
  });

  it('falls back to the path identity when .git is neither a directory nor a gitdir file', () => {
    const root = path.join(workspace, 'no-git');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), 'not a gitdir pointer\n');

    expect(resolveSkillCacheDirectory(root, home)).toContain('no-git--');
  });

  it('treats a git directory with no commondir as its own common directory', () => {
    const root = path.join(workspace, 'plain');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });

    expect(resolveSkillCacheDirectory(root, home)).toContain('plain--');
  });
});

function repositoryAndWorktree(directory: string): [string, string] {
  const segments = directory.split(path.sep);
  const worktreesIndex = segments.indexOf('worktrees');
  return [segments[worktreesIndex - 1]!, segments[worktreesIndex + 1]!];
}

describe('sanitizeSyncLabel', () => {
  it('keeps a name usable as exactly one path segment', () => {
    expect(sanitizeSyncLabel('My Repo/v2', 'repo')).toBe('My-Repo-v2');
    expect(sanitizeSyncLabel('café', 'repo')).toBe('cafe');
  });

  it('falls back rather than emitting an empty or traversal segment', () => {
    expect(sanitizeSyncLabel('///', 'repo')).toBe('repo');
    expect(sanitizeSyncLabel('..', 'repo')).toBe('repo');
    expect(sanitizeSyncLabel('.', 'repo')).toBe('repo');
  });

  it('bounds the segment length', () => {
    expect(sanitizeSyncLabel('a'.repeat(200), 'repo')).toHaveLength(48);
  });
});
