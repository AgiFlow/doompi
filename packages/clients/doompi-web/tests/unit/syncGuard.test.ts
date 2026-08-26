import { describe, expect, it, vi } from 'vitest';
import { createSyncGuard } from '../../src/adapters/syncGuard.ts';

const REPO = '/workspace/repo';
const drifted = { fresh: false, reasons: ['configuration-changed'] as const };
const fresh = { fresh: true, reasons: [] as const };

function guard(readDrift: () => { fresh: boolean; reasons: readonly string[] }, runSync = vi.fn(async () => {})) {
  return {
    runSync,
    guard: createSyncGuard({ repoRoot: REPO, readDrift, runSync, intervalMs: 5 }),
  };
}

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

  it('stops watching once closed', async () => {
    const runSync = vi.fn(async () => {});
    const { guard: subject } = guard(() => drifted, runSync);

    subject.watch(() => {});
    subject.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runSync).not.toHaveBeenCalled();
  });
});
