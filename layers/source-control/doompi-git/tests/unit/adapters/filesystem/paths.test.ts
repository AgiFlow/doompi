import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { doomGitRoot, registryFile, worktreesRoot } from '../../../../src/services/paths';
import { repositoryId } from '../../../../src/services/repositoryIdentity';

const HOME = '/home/tester';
const temporaryDirectories: string[] = [];

function registryEntry(id: string, branch: string = id): object {
  return {
    version: 1,
    id,
    branch,
    baseRef: 'main',
    path: `/worktrees/${id}`,
    repositoryRoot: '/repository',
    sessionId: `session-${id}`,
    parentSessionId: 'parent',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('doomGitRoot and worktreesRoot', () => {
  it('keep this package state outside any checkout', () => {
    expect(doomGitRoot(HOME)).toBe(path.join(HOME, '.pi', '.doom', 'git'));
    expect(worktreesRoot(HOME)).toBe(path.join(HOME, '.pi', '.doom', 'git', 'worktrees'));
  });
});

describe('registryFile', () => {
  it('keys one registry file per repository by shared identity only', () => {
    const file = registryFile('/tmp/Some Repo', HOME);
    const key = path.basename(path.dirname(file));

    expect(file.startsWith(path.join(doomGitRoot(HOME), 'registry'))).toBe(true);
    expect(path.basename(file)).toBe('worktrees.json');
    expect(key).toMatch(/^[0-9a-f]{12}$/u);
  });

  it('resolves the same registry from a main checkout and linked worktree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-registry-'));
    temporaryDirectories.push(root);
    const parent = path.join(root, 'main-checkout');
    const child = path.join(root, 'feature-checkout');
    const childGit = path.join(parent, '.git', 'worktrees', 'feature');
    fs.mkdirSync(childGit, { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(childGit, 'commondir'), '../..');
    fs.writeFileSync(path.join(child, '.git'), `gitdir: ${childGit}`);

    expect(registryFile(parent, root)).toBe(registryFile(child, root));
  });

  it('resolves the repository registry from a session running in a subdirectory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-registry-'));
    temporaryDirectories.push(root);
    const repository = path.join(root, 'repo');
    const nested = path.join(repository, 'packages', 'app');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    expect(registryFile(nested, root)).toBe(registryFile(repository, root));
  });

  it('merges every legacy label-prefixed registry into the canonical file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-legacy-'));
    temporaryDirectories.push(home);
    const repository = path.join(home, 'repository');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    const id = repositoryId(repository);
    for (const [label, entry] of [
      ['main', registryEntry('one')],
      ['feature', registryEntry('two')],
    ] as const) {
      const legacy = path.join(doomGitRoot(home), 'registry', `${label}--${id}`, 'worktrees.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ version: 1, entries: [entry] }));
    }

    const canonical = registryFile(repository, home);
    expect(path.basename(path.dirname(canonical))).toBe(id);
    expect(JSON.parse(fs.readFileSync(canonical, 'utf8'))).toMatchObject({
      version: 1,
      entries: [{ id: 'two' }, { id: 'one' }],
    });
  });

  it('rejects conflicting records while migrating legacy registries', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-conflict-'));
    temporaryDirectories.push(home);
    const repository = path.join(home, 'repository');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    const id = repositoryId(repository);
    for (const [label, branch] of [
      ['main', 'first'],
      ['feature', 'second'],
    ] as const) {
      const legacy = path.join(doomGitRoot(home), 'registry', `${label}--${id}`, 'worktrees.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ version: 1, entries: [registryEntry('same', branch)] }));
    }

    expect(() => registryFile(repository, home)).toThrow("Conflicting legacy worktree registry entries for 'same'.");
  });
});
