import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncGuard } from '../../src/adapters/syncGuard.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const REPO = '/workspace/repo';
const drifted = { fresh: false, reasons: ['configuration-changed'] as const };
const fresh = { fresh: true, reasons: [] as const };

function driftOnce(): () => { fresh: boolean; reasons: readonly string[] } {
  let first = true;
  return () => {
    if (!first) return fresh;
    first = false;
    return drifted;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    expect(readDrift).toHaveBeenCalledWith(REPO, undefined);
    subject.close();
  });

  it('checks the selected repository against the launcher-staged Doom entry', async () => {
    const stagedEntry = '/runtime/doompi/dist/src/extensions/entries/doom.mjs';
    vi.stubEnv('DOOMPI_BOOTSTRAP_ENTRY', stagedEntry);
    const readDrift = vi.fn((_repoRoot: string, _expectedBootstrapEntry?: string) => fresh);
    const subject = createSyncGuard({ repoRoot: REPO, readDrift });

    await subject.ensureSynced();

    expect(readDrift).toHaveBeenCalledWith(REPO, stagedEntry);
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
    const { guard: subject, runSync } = guard(driftOnce());

    await subject.ensureSynced();

    expect(runSync).toHaveBeenCalledWith(REPO);
    subject.close();
  });

  it('runs one sync for sessions launched at the same moment', async () => {
    let release = (): void => {};
    const runSync = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { guard: subject } = guard(driftOnce(), runSync);

    const both = Promise.all([subject.ensureSynced(), subject.ensureSynced()]);
    release();
    await both;

    // Racing launches would otherwise rebuild the same artifacts over each other.
    expect(runSync).toHaveBeenCalledOnce();
    subject.close();
  });

  it('refuses to launch when sync throws', async () => {
    const notices: string[] = [];
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: () => Promise.reject(new Error('compiler unavailable')),
      onNotice: (message) => notices.push(message),
    });

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
    const subject = createSyncGuard({ repoRoot: REPO, readDrift: driftOnce() });

    const pending = subject.ensureSynced();
    child.emit('exit', 0);
    await pending;

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/cli\.mjs$/), 'sync'],
      expect.objectContaining({ cwd: REPO, env: expect.objectContaining({ DOOMPI_ROOT: REPO }) }),
    );
    subject.close();
  });

  it('uses the configured bundled agent when the repository has no pinned CLI', async () => {
    vi.stubEnv('DOOMPI_AGENT_COMMAND', '/runtime/doompi/dist/bin/cli.mjs');
    const child = fakeChild();
    const subject = createSyncGuard({ repoRoot: REPO, readDrift: driftOnce() });

    const pending = subject.ensureSynced();
    child.emit('exit', 0);
    await pending;

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/runtime/doompi/dist/bin/cli.mjs', 'sync'],
      expect.objectContaining({ cwd: REPO }),
    );
    subject.close();
    vi.unstubAllEnvs();
  });

  it('lets an embedded host pin DPI for sync independently from repository installs', async () => {
    vi.stubEnv('DOOMPI_SYNC_COMMAND', '/runtime/doompi/dist/bin/dpi.mjs');
    const child = fakeChild();
    const subject = createSyncGuard({ repoRoot: REPO, readDrift: driftOnce() });

    const pending = subject.ensureSynced();
    child.emit('exit', 0);
    await pending;

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/runtime/doompi/dist/bin/dpi.mjs', 'sync'],
      expect.objectContaining({ cwd: REPO }),
    );
    subject.close();
    vi.unstubAllEnvs();
  });
  it('reports output from a failed packaged sync and rejects the launch', async () => {
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
    await expect(pending).rejects.toThrow('sync failed (exit 1: build failed)');

    expect(notices).toContainEqual(expect.stringMatching(/sync failed \(exit 1: build failed\)/));
    // Saying "complete" after a non-zero exit is what made a broken sync look
    // like a rebuild, and every page reloaded on the strength of it.
    expect(notices).not.toContainEqual('sync complete');
    subject.close();
  });

  it('refuses a session when sync reports failure', async () => {
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: async () => ({ ok: false, detail: 'exit 1: build failed' }),
    });

    await expect(subject.ensureSynced()).rejects.toThrow('exit 1: build failed');
    subject.close();
  });

  it('refuses a session when sync leaves the repository drifted', async () => {
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: async () => ({ ok: true }),
    });

    await expect(subject.ensureSynced()).rejects.toThrow('did not resolve drift');
    subject.close();
  });

  it('does not tell pages to reload when the sync failed', async () => {
    const notices: string[] = [];
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: async () => ({ ok: false, detail: 'exit 1: build failed' }),
      onNotice: (message) => notices.push(message),
      intervalMs: 5,
    });
    const synced = vi.fn();

    subject.watch(synced);
    await new Promise((resolve) => setTimeout(resolve, 60));
    subject.close();

    expect(synced).not.toHaveBeenCalled();
  });

  it('does not announce or hot-loop a sync that leaves the repository drifted', async () => {
    const notices: string[] = [];
    const runSync = vi.fn(async () => ({ ok: true }));
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync,
      onNotice: (message) => notices.push(message),
      intervalMs: 5,
    });
    const synced = vi.fn();

    subject.watch(synced);
    await new Promise((resolve) => setTimeout(resolve, 80));
    subject.close();

    expect(synced).not.toHaveBeenCalled();
    expect(runSync.mock.calls.length).toBeLessThan(8);
    expect(notices).toContainEqual(expect.stringContaining('did not resolve drift'));
    expect(notices).not.toContain('sync complete');
  });

  it('backs off instead of retrying a failing sync every interval', async () => {
    const attempts: number[] = [];
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: async () => {
        attempts.push(Date.now());
        return { ok: false, detail: 'exit 1' };
      },
      intervalMs: 5,
    });

    subject.watch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
    subject.close();

    // Doubling from 5ms reaches past the window after a handful of tries; a
    // fixed interval would have fired an order of magnitude more.
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.length).toBeLessThan(8);
  });

  it('reports a repeated failure once rather than on every retry', async () => {
    const notices: string[] = [];
    const subject = createSyncGuard({
      repoRoot: REPO,
      readDrift: () => drifted,
      runSync: async () => ({ ok: false, detail: 'exit 1: build failed' }),
      onNotice: (message) => notices.push(message),
      intervalMs: 5,
    });

    subject.watch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 80));
    subject.close();

    expect(notices.filter((message) => message.startsWith('sync failed'))).toHaveLength(1);
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
