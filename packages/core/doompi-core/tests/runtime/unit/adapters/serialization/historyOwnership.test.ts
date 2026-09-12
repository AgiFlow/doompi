import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistoryOwnership, historyOwnershipLockPath } from '../../../../../src/services/historyOwnership';
import { preserveHistoryBeforeOpen } from '../../../../../src/services/historyImport';
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
