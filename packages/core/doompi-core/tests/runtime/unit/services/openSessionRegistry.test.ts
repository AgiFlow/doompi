import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenSessionRegistry } from '../../../../src/services/openSessionRegistry';

const directories: string[] = [];

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-open-sessions-'));
  directories.push(directory);
  return directory;
}

function write(directory: string, body: string): string {
  const file = path.join(directory, 'open-sessions.json');
  fs.writeFileSync(file, body);
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe('createOpenSessionRegistry', () => {
  it('survives a reopen and drops a removed session', () => {
    const directory = temporary();
    const registry = createOpenSessionRegistry({ directory });
    registry.add({ sessionId: 'one', workspaceId: 'w', cwd: '/repo', name: 'One', createdAt: '2025-01-01' });
    registry.add({
      sessionId: 'two',
      workspaceId: 'w',
      cwd: '/repo',
      name: 'Two',
      createdAt: '2025-01-02',
      parentSessionId: 'one',
      sessionProvenance: 'worktree',
    });

    expect(createOpenSessionRegistry({ directory }).list()).toEqual(registry.list());
    expect(fs.statSync(path.join(directory, 'open-sessions.json')).mode & 0o077).toBe(0);

    registry.remove('one');
    expect(
      createOpenSessionRegistry({ directory })
        .list()
        .map((record) => record.sessionId),
    ).toEqual(['two']);
  });

  it('replaces rather than duplicates an id that is added twice', () => {
    const directory = temporary();
    const registry = createOpenSessionRegistry({ directory });
    registry.add({ sessionId: 'one', workspaceId: 'w', cwd: '/repo', name: 'First', createdAt: '2025-01-01' });
    registry.add({ sessionId: 'one', workspaceId: 'w', cwd: '/repo', name: 'Second', createdAt: '2025-01-01' });
    expect(registry.list()).toEqual([expect.objectContaining({ sessionId: 'one', name: 'Second' })]);
  });

  it('reports an unreadable file and restores nothing from it', () => {
    const directory = temporary();
    const file = write(directory, '{ not json');
    const onNotice = vi.fn();
    expect(createOpenSessionRegistry({ directory, onNotice }).list()).toEqual([]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining(file));
  });

  it('drops entries whose id or cwd could not have been written by this server', () => {
    const directory = temporary();
    write(
      directory,
      JSON.stringify([
        // A traversal id would be joined into a journal filename.
        { sessionId: '../escape', workspaceId: 'w', cwd: '/repo', name: 'Bad', createdAt: '2025-01-01' },
        { sessionId: 'relative', workspaceId: 'w', cwd: 'repo', name: 'Bad', createdAt: '2025-01-01' },
        { sessionId: 'no-workspace', workspaceId: '', cwd: '/repo', name: 'Bad', createdAt: '2025-01-01' },
        { sessionId: 'good', workspaceId: 'w', cwd: '/repo', name: 'Good', createdAt: '2025-01-01' },
      ]),
    );
    const onNotice = vi.fn();
    expect(
      createOpenSessionRegistry({ directory, onNotice })
        .list()
        .map((record) => record.sessionId),
    ).toEqual(['good']);
    expect(onNotice).toHaveBeenCalledTimes(3);
  });
});
