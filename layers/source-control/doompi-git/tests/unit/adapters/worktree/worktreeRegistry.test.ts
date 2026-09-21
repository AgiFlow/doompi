import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorktreeRegistry } from '../../../../src/services/worktreeRegistry';
import { WORKTREE_RECORD_VERSION, type WorktreeRecord } from '../../../../src/types/worktreeRegistry';

let directory: string;
let file: string;

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    version: WORKTREE_RECORD_VERSION,
    id: 'w1',
    branch: 'wt/fix-auth',
    baseRef: 'main',
    path: '/wt/repo--abc/wt-fix-auth--1234',
    repositoryRoot: '/repo',
    sessionId: 's1',
    parentSessionId: 'p1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-git-registry-'));
  file = path.join(directory, 'worktrees.json');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('createWorktreeRegistry', () => {
  it('reads an empty registry when the file does not exist', () => {
    expect(createWorktreeRegistry(file).list()).toEqual([]);
  });

  it('round-trips records through replace and list', () => {
    const registry = createWorktreeRegistry(file);
    const entries = [record(), record({ id: 'w2', sessionId: 's2' })];
    registry.replace(entries);
    expect(registry.list()).toEqual(entries);
  });

  it('replaces the whole file rather than merging', () => {
    const registry = createWorktreeRegistry(file);
    registry.replace([record()]);
    registry.replace([record({ id: 'w2' })]);
    expect(registry.list().map((entry) => entry.id)).toEqual(['w2']);
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    // Losing track of worktrees is recoverable through prune; refusing to run
    // over a torn write is not.
    fs.writeFileSync(file, '{"version": 1, "entries": [');
    expect(() => createWorktreeRegistry(file).list()).not.toThrow();
    expect(createWorktreeRegistry(file).list()).toEqual([]);
  });

  it('reads non-JSON, a JSON non-object and a null file as empty', () => {
    for (const contents of ['not json at all', '"a string"', 'null', '[]']) {
      fs.writeFileSync(file, contents);
      expect(createWorktreeRegistry(file).list()).toEqual([]);
    }
  });

  it('ignores a file carrying a version this build does not know', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [record()] }));
    expect(createWorktreeRegistry(file).list()).toEqual([]);
  });

  it('ignores a file whose entries are not an array', () => {
    fs.writeFileSync(file, JSON.stringify({ version: WORKTREE_RECORD_VERSION, entries: { id: 'w1' } }));
    expect(createWorktreeRegistry(file).list()).toEqual([]);
  });

  it('filters out malformed entries but keeps the good ones', () => {
    const good = record({ id: 'good' });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: WORKTREE_RECORD_VERSION,
        entries: [
          good,
          { ...record({ id: 'wrong-version' }), version: 99 },
          { ...record({ id: '' }) },
          null,
          'a string',
          { ...record({ id: 'no-path' }), path: undefined },
          { ...record({ id: 'no-branch' }), branch: 7 },
          { ...record({ id: 'no-session' }), sessionId: undefined },
          { ...record({ id: 'no-id' }), id: 42 },
        ],
      }),
    );
    expect(createWorktreeRegistry(file).list()).toEqual([good]);
  });
});

describe('registry process coordination', () => {
  it('waits for a foreign process lock before re-reading and committing', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
      const fs = require('node:fs');
      const lock = process.argv[1] + '.lock';
      fs.mkdirSync(lock);
      process.send('locked');
      process.stdin.once('data', () => { fs.rmdirSync(lock); process.exit(0); });
    `,
        file,
      ],
      { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
    );
    try {
      await once(child, 'message', { signal: AbortSignal.timeout(2000) });
      const registry = createWorktreeRegistry(file);
      let entered = false;
      const operation = registry.transaction(() => {
        entered = true;
        registry.replace([record()]);
      });
      expect(entered).toBe(false);
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(2000) });
      child.stdin!.write('release');
      await exited;
      await operation;
      expect(registry.list()).toEqual([record()]);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it('cancels a waiting writer without stealing an existing lock', async () => {
    fs.mkdirSync(`${file}.lock`);
    const controller = new AbortController();
    const operation = createWorktreeRegistry(file).transaction(() => {
      throw new Error('must not enter');
    }, controller.signal);
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
  });
});
