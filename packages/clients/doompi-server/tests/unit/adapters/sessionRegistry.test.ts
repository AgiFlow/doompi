import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeSessionRecord, writeSessionRecord } from '../../../src/adapters/sessionRegistry.ts';
import type { SessionRecord } from '../../../src/types/registry.ts';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: 'a1b2',
    name: 'untitled',
    cwd: '/workspace/project',
    socketPath: '/run/doompi/a1b2.sock',
    tokenFile: '/run/doompi/a1b2.token',
    pid: 4242,
    createdAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

function freshRegistryDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-registry-')), 'run');
}

describe('writeSessionRecord', () => {
  it('writes an owner-only record under an owner-only sessions directory', () => {
    const registryDir = freshRegistryDir();
    writeSessionRecord(registryDir, record());

    const recordFile = path.join(registryDir, 'sessions', 'a1b2.json');
    expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toEqual(record());
    expect(fs.statSync(recordFile).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(registryDir, 'sessions')).mode & 0o077).toBe(0);
    expect(fs.statSync(registryDir).mode & 0o077).toBe(0);
  });

  it('leaves no temporary file behind', () => {
    const registryDir = freshRegistryDir();
    writeSessionRecord(registryDir, record());

    expect(fs.readdirSync(path.join(registryDir, 'sessions'))).toEqual(['a1b2.json']);
  });

  it('overwrites the record of a restarted session keyed by id', () => {
    const registryDir = freshRegistryDir();
    writeSessionRecord(registryDir, record({ pid: 1000 }));
    writeSessionRecord(registryDir, record({ pid: 2000 }));

    const recordFile = path.join(registryDir, 'sessions', 'a1b2.json');
    expect((JSON.parse(fs.readFileSync(recordFile, 'utf8')) as SessionRecord).pid).toBe(2000);
  });
});

describe('removeSessionRecord', () => {
  it('removes the record and tolerates one already gone', () => {
    const registryDir = freshRegistryDir();
    writeSessionRecord(registryDir, record());

    removeSessionRecord(registryDir, 'a1b2');
    expect(fs.readdirSync(path.join(registryDir, 'sessions'))).toEqual([]);
    expect(() => removeSessionRecord(registryDir, 'a1b2')).not.toThrow();
  });
});
