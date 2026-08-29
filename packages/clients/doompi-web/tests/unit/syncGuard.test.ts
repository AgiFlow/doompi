import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createSyncGuard } from '../../src/adapters/syncGuard.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const REPO = '/workspace/repo';
const drifted = { fresh: false, reasons: ['configuration-changed'] as const };
const fresh = { fresh: true, reasons: [] as const };

function guard(readDrift: () => { fresh: boolean; reasons: readonly string[] }, runSync = vi.fn(async () => {})) {
  return {
    runSync,
    guard: createSyncGuard({ repoRoot: REPO, readDrift, runSync, intervalMs: 5 }),
  };
}

function fakeChild(): ReturnType<typeof spawn> {
  const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() });
  vi.mocked(spawn).mockReturnValue(child);
  return child;
}
describe('cwd sync guard', () => {
  it('stays inactive when the cockpit starts outside a repository', async () => {
    const readDrift = vi.fn(() => drifted);
    const runSync = vi.fn(async () => {});
    const onSynced = vi.fn();
    const subject = createSyncGuard({
      cwd: '/workspace/plain-directory',
      findRoot: () => {
        throw new Error('no repository');
      },
      readDrift,
      runSync,
      intervalMs: 5,
    });

    await subject.ensureSynced();
    subject.watch(onSynced);
    await new Promise((resolve) => setTimeout(resolve, 20));
    subject.close();

    expect(readDrift).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
    expect(onSynced).not.toHaveBeenCalled();
  });

  it('guards the repository resolved from the cockpit launch directory', async () => {
    const findRoot = vi.fn(() => REPO);
    const readDrift = vi.fn(() => fresh);
    const subject = createSyncGuard({ cwd: '/workspace/repo/packages/web', findRoot, readDrift });

    await subject.ensureSynced();

    expect(findRoot).toHaveBeenCalledWith('/workspace/repo/packages/web');
    expect(readDrift).toHaveBeenCalledWith(REPO);
    subject.close();
  });
});

describe('sync guard', () => {
  it('leaves a synced repository alone', async () => {
    const { guard: subject, runSync } = guard(() => fresh);

    await subject.ensureSynced();

    expect(runSync).not.toHaveBeenCalled();
    subject.close();
  });

  it('syncs when anything a session reads has drifted', async () => {
    const { guard: subject, runSync } = guard(() => drifted);

    await subject.ensureSynced();

    expect(runSync).toHaveBeenCalledWith(REPO);
    subject.close();
  });

  it('runs one sync for sessions launched at the same moment', async () => {
    let release = (): void => {};
    const runSync = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { guard: subject } = guard(() => drifted, runSync);

    const both = Promise.all([subject.ensureSynced(), subject.ensureSynced()]);
    release();
    await both;

    // Racing launches would otherwise rebuild the same artifacts over each other.
    expect(runSync).toHaveBeenCalledOnce();
    subject.close();
  });

  it('reports a sync that failed instead of failing the launch', async () => {
    const notices: string[] = [];
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: () => Promise.reject(new Error('compiler unavailable')),
      onNotice: (message) => notices.push(message),
    });

    // The caller wanted a session; a stale sync is worse than no session only
    // if it also takes the session away.
    await expect(subject.ensureSynced()).rejects.toThrow('compiler unavailable');
    subject.close();
  });

  it('tells the caller once the watcher rebuilt what a page is running', async () => {
    let state = drifted as { fresh: boolean; reasons: readonly string[] };
    const runSync = vi.fn(async () => {
      state = fresh;
    });
    const { guard: subject } = guard(() => state, runSync);
    const synced = vi.fn();

    subject.watch(synced);
    await vi.waitFor(() => expect(synced).toHaveBeenCalled(), { timeout: 1000 });

    subject.close();
    expect(runSync).toHaveBeenCalledOnce();
  });

  it('runs the packaged sync command when no runner is injected', async () => {
    const child = fakeChild();
    const subject = createSyncGuard({ repoRoot: REPO, readDrift: () => drifted });

    const pending = subject.ensureSynced();
    child.emit('exit', 0);
    await pending;

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/cli\.mjs$/), 'sync'],
      expect.objectContaining({ cwd: REPO }),
    );
    subject.close();
  });

  it('reports output from a failed packaged sync without rejecting the launch', async () => {
    const notices: string[] = [];
    const child = fakeChild();
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      onNotice: (message) => notices.push(message),
    });

    const pending = subject.ensureSynced();
    child.stderr?.emit('data', Buffer.from('build failed'));
    child.emit('exit', 1);
    await pending;

    expect(notices).toContainEqual(expect.stringMatching(/sync exited 1: build failed/));
    subject.close();
  });

  it('stops watching once closed', async () => {
    const runSync = vi.fn(async () => {});
    const { guard: subject } = guard(() => drifted, runSync);

    subject.watch(() => {});
    subject.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runSync).not.toHaveBeenCalled();
  });
});
