import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSyncLocation, sanitizeSyncLabel } from '../../src/adapters/syncLocation';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sync-location-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('sync location', () => {
  it('places generated state beneath the injected home directory', () => {
    const root = temporaryDirectory();
    const home = temporaryDirectory();
    const location = resolveSyncLocation(root, home);

    expect(location.directory).toMatch(
      new RegExp(`^${path.join(home, '.pi', '.doom', 'sync').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    );
    expect(location.statePath).toBe(path.join(location.directory, 'state.json'));
    expect(location.legacyDirectory).toBe(path.join(fs.realpathSync(root), '.pi', 'doom'));
    expect(location.identity.repositoryId).toMatch(/^[a-f0-9]{32}$/u);
    expect(location.identity.worktreeId).toMatch(/^[a-f0-9]{32}$/u);
  });

  it('groups linked worktrees while isolating their generated directories', () => {
    const main = temporaryDirectory();
    const common = path.join(main, '.git');
    const linked = path.join(main, 'linked');
    const admin = path.join(common, 'worktrees', 'linked');
    const home = temporaryDirectory();
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(linked, { recursive: true });
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${admin}\n`);

    const mainLocation = resolveSyncLocation(main, home);
    const linkedLocation = resolveSyncLocation(linked, home);

    expect(linkedLocation.identity.repositoryId).toBe(mainLocation.identity.repositoryId);
    expect(linkedLocation.repositoryDirectory).toBe(mainLocation.repositoryDirectory);
    expect(linkedLocation.identity.worktreeId).not.toBe(mainLocation.identity.worktreeId);
    expect(linkedLocation.directory).not.toBe(mainLocation.directory);
  });

  it('canonicalizes symlink aliases before deriving identity', () => {
    const root = temporaryDirectory();
    const parent = temporaryDirectory();
    const alias = path.join(parent, 'alias');
    const home = temporaryDirectory();
    fs.symlinkSync(root, alias, 'dir');

    expect(resolveSyncLocation(alias, home).identity).toEqual(resolveSyncLocation(root, home).identity);
  });

  it('sanitizes labels without using them as identity', () => {
    expect(sanitizeSyncLabel(' feature/a ', 'fallback')).toBe('feature-a');
    expect(sanitizeSyncLabel('../..', 'fallback')).toBe('fallback');
    expect(sanitizeSyncLabel('Crème brûlée', 'fallback')).toBe('Creme-brulee');
  });
});
