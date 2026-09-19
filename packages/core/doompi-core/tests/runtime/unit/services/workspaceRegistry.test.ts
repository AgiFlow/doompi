import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceRegistry } from '../../../../src/services/workspaceRegistry';

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
