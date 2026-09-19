import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { doomGitRoot, hubRegistryDir, registryFile, worktreesRoot } from '../../../../src/services/paths';
import { repositoryId } from '../../../../src/services/repositoryIdentity';

const ENV_NAME = 'DOOMPI_RUNTIME_DIR';
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

describe('hubRegistryDir', () => {
  it('prefers the flag over the env var and the home default', () => {
    // The hub passes --registry-dir to its children and also exports the env
    // var, so the flag has to win or a child watches the wrong directory.
    const resolved = hubRegistryDir(
      ['node', 'server.mjs', '--registry-dir', '/run/from-flag'],
      { [ENV_NAME]: '/run/from-env' },
      HOME,
    );
    expect(resolved).toBe('/run/from-flag');
  });

  it('prefers the env var over the home default when there is no flag', () => {
    expect(hubRegistryDir(['node', 'server.mjs'], { [ENV_NAME]: '/run/from-env' }, HOME)).toBe('/run/from-env');
  });

  it('falls back to the home default when neither is given', () => {
    expect(hubRegistryDir(['node', 'server.mjs'], {}, HOME)).toBe(`${HOME}/.doompi/run`);
  });

  it('ignores a trailing flag with no value', () => {
    expect(hubRegistryDir(['node', 'server.mjs', '--registry-dir'], { [ENV_NAME]: '/run/from-env' }, HOME)).toBe(
      '/run/from-env',
    );
    expect(hubRegistryDir(['node', 'server.mjs', '--registry-dir'], {}, HOME)).toBe(`${HOME}/.doompi/run`);
  });
});
