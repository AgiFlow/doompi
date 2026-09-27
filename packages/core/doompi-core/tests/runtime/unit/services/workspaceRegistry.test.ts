import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceRegistry,
  identifyWorkspace,
  readWorkspaceMarker,
  writeWorkspaceMarker,
} from '../../../../src/services/workspaceRegistry';

const directories: string[] = [];

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-workspaces-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe('createWorkspaceRegistry', () => {
  it('persists workspace membership independently of sessions', () => {
    const directory = temporary();
    const registry = createWorkspaceRegistry({ directory });
    registry.add({ id: 'one', root: '/repo/one' });
    registry.add({ id: 'two', root: '/repo/two' });

    expect(createWorkspaceRegistry({ directory }).list()).toEqual(registry.list());
    expect(fs.statSync(path.join(directory, 'workspaces.json')).mode & 0o077).toBe(0);

    registry.remove('one');
    expect(createWorkspaceRegistry({ directory }).list()).toEqual([{ id: 'two', root: '/repo/two' }]);
  });

  it('replaces duplicate identities and ignores invalid persisted entries', () => {
    const directory = temporary();
    fs.writeFileSync(
      path.join(directory, 'workspaces.json'),
      JSON.stringify([
        { id: 'same', root: '/old' },
        { id: 'same', root: '/duplicate' },
        { id: '', root: '/invalid' },
        { id: 'relative', root: 'relative' },
      ]),
    );
    const onNotice = vi.fn();
    const registry = createWorkspaceRegistry({ directory, onNotice });

    expect(registry.list()).toEqual([{ id: 'same', root: '/old' }]);
    expect(onNotice).toHaveBeenCalledTimes(2);
    registry.add({ id: 'same', root: '/new' });
    expect(registry.list()).toEqual([{ id: 'same', root: '/new' }]);
  });

  it('keeps memory unchanged when durable persistence fails', () => {
    const directory = temporary();
    const registry = createWorkspaceRegistry({ directory });
    registry.add({ id: 'one', root: '/repo/one' });
    fs.rmSync(path.join(directory, 'workspaces.json'));
    fs.rmSync(directory, { recursive: true });
    fs.writeFileSync(directory, 'not a directory');

    expect(() => registry.add({ id: 'two', root: '/repo/two' })).toThrow('could not be saved');
    expect(registry.list()).toEqual([{ id: 'one', root: '/repo/one' }]);
  });
});

describe('identifyWorkspace', () => {
  const records = [
    { id: 'legacy0123456789ab', root: '/repo/main' },
    { id: 'other', root: '/repo/other' },
  ];

  it('keeps a recorded id, legacy path hashes included, for its exact root', () => {
    expect(identifyWorkspace({ records, checkoutRoot: '/repo/main', marker: 'other' })).toEqual({
      id: 'legacy0123456789ab',
      root: '/repo/main',
      moved: false,
    });
  });

  it('joins another checkout of an admitted repository to its workspace', () => {
    expect(
      identifyWorkspace({ records, checkoutRoot: '/elsewhere/feature', marker: 'other', exists: () => true }),
    ).toEqual({ id: 'other', root: '/repo/other', moved: false });
  });

  it('rebinds a workspace whose repository moved', () => {
    expect(identifyWorkspace({ records, checkoutRoot: '/moved/other', marker: 'other', exists: () => false })).toEqual({
      id: 'other',
      root: '/moved/other',
      moved: true,
    });
  });

  it('mints a new id for an unknown checkout, or reuses its marker', () => {
    expect(identifyWorkspace({ records, checkoutRoot: '/new', newId: () => 'fresh' })).toEqual({
      id: 'fresh',
      root: '/new',
      moved: false,
    });
    expect(identifyWorkspace({ records, checkoutRoot: '/new', marker: 'forgotten' })).toMatchObject({
      id: 'forgotten',
    });
  });
});

describe('workspace marker', () => {
  it('lives in the git data shared by every worktree of the repository', () => {
    const main = temporary();
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const feature = temporary();
    fs.writeFileSync(path.join(feature, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`);

    expect(readWorkspaceMarker(main)).toBeUndefined();
    expect(writeWorkspaceMarker(main, 'workspace-id')).toBe(true);
    expect(readWorkspaceMarker(feature)).toBe('workspace-id');
  });

  it('has nowhere to live outside a git checkout', () => {
    const plain = temporary();
    expect(writeWorkspaceMarker(plain, 'workspace-id')).toBe(false);
    expect(readWorkspaceMarker(plain)).toBeUndefined();
  });
});
