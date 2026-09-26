import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { preserveHistoryBeforeOpen } from '../../../../../src/services/historyImport';
import { createHistoryOwnership, historyOwnershipLockPath } from '../../../../../src/services/historyOwnership';
function v4Source(): string {
  return `${JSON.stringify({
    v: 4,
    kind: 'header',
    id: 'session',
    storageVersion: 1,
    createdAt: 0,
    cwd: '/workspace',
  })}\n`;
}

describe('canonical v4 history ownership', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-history-owner-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses one lock through source and directory symlinks', async () => {
    const source = path.join(root, 'session.jsonl');
    fs.writeFileSync(source, v4Source());
    const alias = path.join(root, 'alias.jsonl');
    fs.symlinkSync(source, alias);
    const lease = await createHistoryOwnership().acquire(source);
    try {
      expect(historyOwnershipLockPath(alias)).toBe(historyOwnershipLockPath(source));
      await expect(createHistoryOwnership().acquire(alias)).rejects.toThrow('lock');
    } finally {
      await lease.release();
    }
  });

  it('rejects hard-linked journals instead of permitting a second writer path', async () => {
    const source = path.join(root, 'session.jsonl');
    fs.writeFileSync(source, v4Source());
    fs.linkSync(source, path.join(root, 'alias.jsonl'));
    await expect(createHistoryOwnership().acquire(source)).rejects.toThrow('independent regular file');
  });

  it('preserves exact damaged bytes and provenance before allowing native repair', async () => {
    const source = path.join(root, 'session.jsonl');
    const damaged = `${v4Source()}{"truncated":`;
    fs.writeFileSync(source, damaged);
    const lease = await createHistoryOwnership().acquire(source);
    try {
      const original = await preserveHistoryBeforeOpen(source, lease);
      fs.writeFileSync(source, v4Source());
      expect(fs.readFileSync(original, 'utf8')).toBe(damaged);
      expect(fs.statSync(original).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(`${original}.json`, 'utf8')).source.realPath).toBe(fs.realpathSync(source));
    } finally {
      await lease.release();
    }
  });

  it('holds the exclusive sidecar through the lease lifetime', async () => {
    const sourcePath = path.join(root, 'session.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const first = createHistoryOwnership();
    const second = createHistoryOwnership();
    const lease = await first.acquire(sourcePath);

    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(true);
    await expect(second.acquire(sourcePath)).rejects.toThrow(/already|lock/i);

    await lease.release();
    const resumed = await second.acquire(sourcePath);
    await resumed.release();
  });

  it('rejects v3 and ambiguous sidecars without reclaiming them', async () => {
    const sourcePath = path.join(root, 'legacy.jsonl');
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({ type: 'session', version: 3, id: 'legacy', timestamp: 0, cwd: root })}\n`,
    );
    await expect(createHistoryOwnership().acquire(sourcePath)).rejects.toThrow(/only supports canonical v4/i);
    expect(fs.existsSync(historyOwnershipLockPath(sourcePath))).toBe(false);

    const staleLock = historyOwnershipLockPath(path.join(root, 'stale.jsonl'));
    fs.writeFileSync(staleLock, '{not-json');
    await expect(createHistoryOwnership().acquire(path.join(root, 'stale.jsonl'))).rejects.toThrow(/lock/i);
    expect(fs.readFileSync(staleLock, 'utf8')).toBe('{not-json');
  });

  it('recovers a complete dead-owner lock but never a live or ambiguous one', async () => {
    const sourcePath = path.join(root, 'session.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const lockPath = historyOwnershipLockPath(sourcePath);
    const stale = {
      version: 1,
      format: 'doompi-v4-history-ownership',
      pid: 99999999,
      sourcePath: fs.realpathSync(sourcePath),
      token: '0cc2f679-c8a9-4b5f-8137-d50372c0b623',
    };
    fs.writeFileSync(lockPath, JSON.stringify(stale));
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === stale.pid) throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
      return realKill(pid, signal);
    });

    const lease = await createHistoryOwnership().acquire(sourcePath);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    await expect(createHistoryOwnership().acquire(sourcePath)).rejects.toThrow(/already exists/);
    await lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.writeFileSync(lockPath, JSON.stringify({ ...stale, sourcePath: path.join(root, 'other.jsonl') }));
    await expect(createHistoryOwnership().acquire(sourcePath)).rejects.toThrow(/already exists/);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).sourcePath).toBe(path.join(root, 'other.jsonl'));
    expect(fs.existsSync(`${lockPath}.recovery`)).toBe(false);
  });

  it('allows only one contender to recover and acquire a dead owner lock', async () => {
    const sourcePath = path.join(root, 'session.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    fs.writeFileSync(
      historyOwnershipLockPath(sourcePath),
      JSON.stringify({
        version: 1,
        format: 'doompi-v4-history-ownership',
        pid: 99999999,
        sourcePath: fs.realpathSync(sourcePath),
        token: '0cc2f679-c8a9-4b5f-8137-d50372c0b623',
      }),
    );
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 99999999) throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
      return realKill(pid, signal);
    });
    const lockPath = historyOwnershipLockPath(sourcePath);
    const unlink = fs.unlinkSync.bind(fs);
    let contender: Promise<unknown> | undefined;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (file === lockPath) contender = Promise.resolve(createHistoryOwnership().acquire(sourcePath));
      return unlink(file);
    });
    const lease = await createHistoryOwnership().acquire(sourcePath);
    expect(contender).toBeDefined();
    await expect(contender).rejects.toThrow(/already exists/);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    await lease.release();
  });

  it('recovers a dead acquisition guard but refuses a live or unrecognizable guard', async () => {
    const sourcePath = path.join(root, 'session.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const guard = `${historyOwnershipLockPath(sourcePath)}.recovery`;
    fs.mkdirSync(guard);
    const marker = path.join(guard, 'owner-0cc2f679-c8a9-4b5f-8137-d50372c0b623.json');
    fs.writeFileSync(marker, JSON.stringify({ pid: 99999999 }));
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 99999999) throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
      return realKill(pid, signal);
    });
    const lease = await createHistoryOwnership().acquire(sourcePath);
    expect(fs.existsSync(guard)).toBe(false);
    await lease.release();

    fs.mkdirSync(guard);
    fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }));
    await expect(createHistoryOwnership().acquire(sourcePath)).rejects.toThrow(/already exists/);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    fs.writeFileSync(path.join(guard, 'unknown'), 'ambiguous');
    await expect(createHistoryOwnership().acquire(sourcePath)).rejects.toThrow(/already exists/);
    expect(fs.existsSync(path.join(guard, 'unknown'))).toBe(true);
  });

  it('delegates managed quiescence without claiming unmanaged Pi is stopped', async () => {
    const sourcePath = path.join(root, 'session.jsonl');
    fs.writeFileSync(sourcePath, v4Source());
    const assertQuiescent = vi.fn();
    const lease = await createHistoryOwnership({ assertQuiescent }).acquire(sourcePath);

    await lease.assertQuiescent();
    expect(assertQuiescent).toHaveBeenCalledWith(fs.realpathSync(sourcePath));
    await lease.release();
  });
});
