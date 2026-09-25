import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenSessionRegistry } from '../../../../src/services/openSessionRegistry';
import { resolveSyncLocation, syncGenerationDirectory } from '../../../../src/services/syncLocation';
import {
  DOOMPI_API_VERSION,
  SYNC_REGISTRATION_VERSION,
  syncStateSha256,
  type SyncRegistration,
} from '../../../../src/services/syncRegistration';

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

function artifact(root: string, home: string): SyncRegistration {
  const location = resolveSyncLocation(root, home);
  const generation = 'parent-generation';
  const generationRoot = syncGenerationDirectory(location, generation);
  const statePath = path.join(generationRoot, 'state.json');
  const apiDirectory = path.join(generationRoot, 'api');
  fs.mkdirSync(apiDirectory, { recursive: true });
  fs.writeFileSync(statePath, '{}\n');

  const packageRoot = fs.realpathSync(fs.mkdtempSync(path.join(home, 'doompi-package-')));
  const entry = path.join(packageRoot, 'dist', 'doom.mjs');
  const manifestPath = path.join(packageRoot, 'package.json');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'export default () => undefined;\n');
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      name: '@agimon-ai/doompi',
      version: '1.0.0',
      doompiApiVersion: DOOMPI_API_VERSION,
      pi: { extensions: ['./dist/doom.mjs'] },
    })}\n`,
  );

  return {
    version: SYNC_REGISTRATION_VERSION,
    root: location.root,
    identity: location.identity,
    generation,
    generationRoot,
    statePath,
    stateSha256: syncStateSha256(statePath),
    webDirectory: null,
    apiDirectory,
    package: {
      root: packageRoot,
      version: '1.0.0',
      apiVersion: DOOMPI_API_VERSION,
      manifestPath,
      entry,
    },
  };
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

  it('persists and revalidates an inherited runtime generation', () => {
    const directory = temporary();
    const home = temporary();
    const root = fs.realpathSync(temporary());
    const inherited = artifact(root, home);
    const registry = createOpenSessionRegistry({ directory, homeDirectory: home });
    const record = {
      sessionId: 'child',
      workspaceId: 'workspace',
      cwd: '/worktree',
      name: 'Child',
      createdAt: '2026-09-25',
      parentSessionId: 'parent',
      sessionProvenance: 'worktree',
      artifact: inherited,
    };

    expect(registry.add(record)).toBe(true);
    expect(createOpenSessionRegistry({ directory, homeDirectory: home }).list()).toEqual([record]);
  });

  it('drops a persisted session whose inherited runtime is no longer valid', () => {
    const directory = temporary();
    const home = temporary();
    const root = fs.realpathSync(temporary());
    const inherited = artifact(root, home);
    write(
      directory,
      JSON.stringify([
        {
          sessionId: 'child',
          workspaceId: 'workspace',
          cwd: '/worktree',
          name: 'Child',
          createdAt: '2026-09-25',
          artifact: { ...inherited, stateSha256: '0'.repeat(64) },
        },
      ]),
    );
    const onNotice = vi.fn();

    expect(createOpenSessionRegistry({ directory, homeDirectory: home, onNotice }).list()).toEqual([]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('unusable entry'));
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
  it('does not publish an unpersisted session when durable recording fails', () => {
    const directory = temporary();
    const onNotice = vi.fn();
    const registry = createOpenSessionRegistry({ directory, onNotice });
    const record = { sessionId: 'one', workspaceId: 'w', cwd: '/repo', name: 'One', createdAt: '2026-09-21' };
    expect(registry.add(record)).toBe(true);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    try {
      expect(registry.add({ ...record, sessionId: 'two' })).toBe(false);
      expect(registry.list()).toEqual([record]);
      expect(createOpenSessionRegistry({ directory }).list()).toEqual([record]);
    } finally {
      rename.mockRestore();
    }
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('could not be saved'));
  });
});
