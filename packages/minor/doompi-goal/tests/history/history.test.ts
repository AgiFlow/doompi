import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireHistoryLock } from '../../src/adapters/node/historyLock.ts';
import { GoalHistoryStore } from '../../src/adapters/node/historyStore.ts';
import { resolveRepositoryIdentity } from '../../src/adapters/node/repositoryIdentity.ts';
import { GOAL_HISTORY_MAX_ENTRIES } from '../../src/services/history/historyPolicy.ts';
import { GoalHistoryService } from '../../src/services/history/historyService.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'doompi-goal-history-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function entry(id: string, archivedAt = new Date().toISOString()) {
  return { id, objective: `objective-${id}`, status: 'complete' as const, archivedAt };
}

describe('repository identity', () => {
  it('shares identity for linked worktrees through git commondir', () => {
    const root = temporaryDirectory();
    const common = path.join(root, '.git');
    const worktree = path.join(root, 'worktree');
    const admin = path.join(common, 'worktrees', 'one');
    mkdirSync(common, { recursive: true });
    mkdirSync(admin, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${admin}\n`);
    const main = resolveRepositoryIdentity(root);
    const linked = resolveRepositoryIdentity(worktree);
    expect(linked.token).toBe(main.token);
    expect(linked.hash).toBe(main.hash);
  });

  it('prefers a nearer nested repository over DOOMPI_ROOT', () => {
    const root = temporaryDirectory();
    const nested = path.join(root, 'nested');
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(nested, '.git'), { recursive: true });
    const identity = resolveRepositoryIdentity(nested, { doompiRoot: root });
    expect(identity.root).toBe(realpathSync(nested));
  });
});

describe('history locks', () => {
  it('recovers a stale owner by renaming the lock directory', async () => {
    const cwd = temporaryDirectory();
    const lockPath = path.join(cwd, 'history.json.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ token: 'old', pid: 999999, createdAt: 0 }));
    const lock = await acquireHistoryLock(lockPath, { staleMs: 1, pidAlive: () => false });
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails closed when a live owner exceeds the lock timeout', async () => {
    const cwd = temporaryDirectory();
    const lockPath = path.join(cwd, 'history.json.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ token: 'live', pid: process.pid, createdAt: Date.now() }),
    );
    await expect(
      acquireHistoryLock(lockPath, { timeoutMs: 20, retryMs: 1, staleMs: 60_000, pidAlive: () => true }),
    ).rejects.toThrow('Timed out');
  });
});

describe('locked history store', () => {
  it('merges concurrent archives without lost updates and remains idempotent', async () => {
    const cwd = temporaryDirectory();
    const agentDir = path.join(cwd, 'agent');
    const first = new GoalHistoryStore(cwd, { agentDir });
    const second = new GoalHistoryStore(cwd, { agentDir });
    await Promise.all([first.archive(entry('a')), second.archive(entry('b')), first.archive(entry('a'))]);
    expect((await first.list()).map(({ id }) => id).sort()).toEqual(['a', 'b']);
  });

  it('quarantines malformed documents before failing closed', async () => {
    const cwd = temporaryDirectory();
    const store = new GoalHistoryStore(cwd, { agentDir: path.join(cwd, 'agent') });
    mkdirSync(path.dirname(store.filePath), { recursive: true });
    writeFileSync(store.filePath, '{ malformed');
    await expect(store.list()).rejects.toThrow('quarantined');
    expect(existsSync(store.corruptDirectory)).toBe(true);
    const [name] = readdirSync(store.corruptDirectory);
    expect(name).toBeDefined();
    expect(readFileSync(path.join(store.corruptDirectory, name as string), 'utf8')).toContain('{ malformed');
  });

  it('creates a tombstone that prevents stale archive resurrection', async () => {
    const cwd = temporaryDirectory();
    const store = new GoalHistoryStore(cwd, { agentDir: path.join(cwd, 'agent') });
    await store.archive(entry('gone'));
    await store.remove('gone');
    await expect(store.archive(entry('gone'))).rejects.toThrow('explicitly removed');
    expect(await store.list()).toEqual([]);
  });

  it('prunes capacity while retaining newest records', async () => {
    const cwd = temporaryDirectory();
    const store = new GoalHistoryStore(cwd, { agentDir: path.join(cwd, 'agent') });
    for (let index = 0; index < GOAL_HISTORY_MAX_ENTRIES + 5; index += 1) {
      await store.archive(entry(String(index).padStart(3, '0'), new Date(index * 1000).toISOString()));
    }
    const entries = await store.list();
    expect(entries).toHaveLength(GOAL_HISTORY_MAX_ENTRIES);
    expect(entries.some(({ id }) => id === '104')).toBe(true);
    expect(entries.some(({ id }) => id === '000')).toBe(false);
  });

  it('creates a fresh goal identity for a history restart', async () => {
    const cwd = temporaryDirectory();
    const store = new GoalHistoryStore(cwd, { agentDir: path.join(cwd, 'agent') });
    await store.archive({ ...entry('restart'), budget: 5000 });
    const restart = await new GoalHistoryService(store).restart('restart');
    expect(restart.historyId).toBe('restart');
    expect(restart.goalId).not.toBe('restart');
    expect(restart.objective).toBe('objective-restart');
    expect(restart.budget).toBe(5000);
  });
});

describe('history identity and lock fallback branches', () => {
  it('falls back through configured root, Doom marker, and cwd identities', () => {
    const root = temporaryDirectory();
    const nested = path.join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    const configured = resolveRepositoryIdentity(nested, { doompiRoot: root });
    expect(configured.token).toContain('root:');
    const marker = path.join(root, 'marker');
    mkdirSync(path.join(marker, '.doom'), { recursive: true });
    expect(
      resolveRepositoryIdentity(path.join(marker, 'child'), { doompiRoot: path.join(marker, 'missing-root') }).root,
    ).toBe(realpathSync(marker));
    const plain = temporaryDirectory();
    expect(
      resolveRepositoryIdentity(plain, {
        doompiRoot: path.join(plain, 'missing-root'),
        realpath: () => {
          throw new Error('not real yet');
        },
      }).token,
    ).toContain('cwd:');
  });

  it('recovers malformed lock owners and ignores mismatched releases', async () => {
    const cwd = temporaryDirectory();
    const lockPath = path.join(cwd, 'history.json.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, 'owner.json'), '{ malformed');
    const lock = await acquireHistoryLock(lockPath, { staleMs: 0, timeoutMs: 100, retryMs: 1, pidAlive: () => false });
    expect(lock.token).toBeTypeOf('string');
    lock.release();
    const replacement = await acquireHistoryLock(lockPath, { timeoutMs: 100, retryMs: 1 });
    expect(() => replacement.release()).not.toThrow();
    expect(() => replacement.release()).not.toThrow();
  });
});
