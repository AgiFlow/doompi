import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpawnHandshake, type SpawnHandshakeOutcome } from '../../src/adapters/runs/background/spawnHandshake';

/** Exposes the base (real `node:fs`) seam implementations directly, without overriding them. */
class RealFsSpawnHandshake extends SpawnHandshake {
  publicReadFile(filePath: string): string | undefined {
    return this.readFile(filePath);
  }

  publicWatchDirectory(dirPath: string, onEvent: () => void): { close: () => void } | undefined {
    return this.watchDirectory(dirPath, onEvent);
  }
}

/**
 * Exposes the protected seams so a test can control what the "filesystem"
 * reports without touching the real `node:fs` module (its ESM namespace is
 * frozen, so `vi.spyOn(fs, ...)` is not an option).
 */
class TestSpawnHandshake extends SpawnHandshake {
  protected override readonly pollIntervalMs = 20;
  protected override readonly defaultTimeoutMs = 1000;

  /** What `readFile` returns for the handshake path. `undefined` means "not written yet". */
  fileContent: string | undefined;
  readFileCalls = 0;

  /** The most recent watcher's event callback and close spy, so a test can fire or inspect it. */
  lastWatchEvent: (() => void) | undefined;
  lastWatchClose = vi.fn();
  /** Set to false to simulate a platform where `fs.watch` cannot be set up at all. */
  watchSucceeds = true;

  protected override readFile(_filePath: string): string | undefined {
    this.readFileCalls += 1;
    return this.fileContent;
  }

  protected override watchDirectory(_dirPath: string, onEvent: () => void) {
    if (!this.watchSucceeds) return undefined;
    this.lastWatchEvent = onEvent;
    this.lastWatchClose = vi.fn();
    return { close: this.lastWatchClose };
  }
}

const HANDSHAKE_PATH = '/tmp/doom-team-test/spawn-42/handshake.json';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SpawnHandshake resolving from the handshake file', () => {
  it('resolves signalled immediately when the file already says ready before the wait even starts', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'ready' });

    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });
    const outcome = await promise;

    expect(outcome).toEqual<SpawnHandshakeOutcome>({ status: 'signalled' });
  });

  it('resolves failed with the child-reported message when the file says error', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'error', error: 'agent binary not found' });

    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });
    const outcome = await promise;

    expect(outcome).toEqual<SpawnHandshakeOutcome>({ status: 'failed', error: 'agent binary not found' });
  });

  it('falls back to a generic message when the error state omits a usable error string', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'error' });

    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });
    const outcome = await promise;

    expect(outcome).toEqual<SpawnHandshakeOutcome>({ status: 'failed', error: expect.any(String) });
  });

  it('keeps waiting through a torn read instead of treating invalid JSON as a definite outcome', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = '{"state": "rea'; // a write caught mid-rename

    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    // Give it a couple of poll cycles while still torn; must not have settled.
    await vi.advanceTimersByTimeAsync(60);

    handshake.fileContent = JSON.stringify({ state: 'ready' });
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });

  it('keeps waiting when the file has JSON but not a recognised state', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'writing-log' });

    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });
    await vi.advanceTimersByTimeAsync(60);

    handshake.fileContent = JSON.stringify({ state: 'ready' });
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });
});

describe('SpawnHandshake watch-first, poll-as-safety-net', () => {
  it('resolves as soon as the watcher fires, without waiting for the next poll', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    // Nothing yet; the file appears and the watch fires before any poll would.
    handshake.fileContent = JSON.stringify({ state: 'ready' });
    handshake.lastWatchEvent?.();

    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });

  it('still resolves via the poll safety net when fs.watch could not be set up at all', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.watchSucceeds = false;
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    expect(handshake.lastWatchEvent).toBeUndefined();

    handshake.fileContent = JSON.stringify({ state: 'ready' });
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });

  it('checks on the poll cadence even while the watcher stays silent', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    handshake.fileContent = JSON.stringify({ state: 'ready' });
    // No watch event fired; only time passing should surface the change.
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });
});

describe('SpawnHandshake timeout', () => {
  it('resolves timed-out, distinguishable from a signalled or failed outcome, when nothing ever appears', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH, timeoutMs: 500 });

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toEqual({ status: 'timed-out' });
  });

  it('uses the injected default timeout when the caller does not specify one', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    await vi.advanceTimersByTimeAsync(999);
    // Not settled yet: the default is 1000ms in this test subclass.

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ status: 'timed-out' });
  });

  it('does not time out once the handshake has already been read as a signal', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'ready' });
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH, timeoutMs: 100 });

    await expect(promise).resolves.toEqual({ status: 'signalled' });

    // Running well past the timeout afterward must not change the settled outcome.
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });
});

describe('SpawnHandshake.cancel', () => {
  it('rejects the promise with the given reason', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise, cancel } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    cancel('child process exited before signalling');

    await expect(promise).rejects.toThrow('child process exited before signalling');
  });

  it('tears down the watcher and timers on cancel, the same as any other terminal path', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise, cancel } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    cancel('no longer needed');

    expect(handshake.lastWatchClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(promise).rejects.toThrow('no longer needed');
  });

  it('does nothing when called after the wait has already settled', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'ready' });
    const { promise, cancel } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    await expect(promise).resolves.toEqual({ status: 'signalled' });

    // A cancel that loses a race with settling must not turn a resolution into
    // a rejection, and must not throw for calling it "too late".
    expect(() => cancel('too late')).not.toThrow();
    await expect(promise).resolves.toEqual({ status: 'signalled' });
  });

  it('is safe to call twice', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise, cancel } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    cancel('first');
    expect(() => cancel('second')).not.toThrow();
    // Only the first reason wins; the second call must not replace it or throw.
    await expect(promise).rejects.toThrow('first');
  });
});

describe('SpawnHandshake teardown', () => {
  it('clears the poll timer and closes the watcher once signalled', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'ready' });
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    await promise;

    expect(handshake.lastWatchClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the poll timer and closes the watcher on timeout', async () => {
    const handshake = new TestSpawnHandshake();
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH, timeoutMs: 40 });

    await vi.advanceTimersByTimeAsync(40);
    await promise;

    expect(handshake.lastWatchClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never keeps the process alive: both timers are unrefed', () => {
    const handshake = new TestSpawnHandshake();
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      unrefSpies.push(vi.spyOn(timer, 'unref'));
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
      const timer = originalSetInterval(...args);
      unrefSpies.push(vi.spyOn(timer, 'unref'));
      return timer;
    }) as typeof setInterval);

    handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    expect(unrefSpies).toHaveLength(2);
    for (const spy of unrefSpies) expect(spy).toHaveBeenCalled();
  });

  it('ignores a watch event or poll tick that arrives after settling, so it cannot resolve twice', async () => {
    const handshake = new TestSpawnHandshake();
    handshake.fileContent = JSON.stringify({ state: 'ready' });
    const { promise } = handshake.waitForHandshake({ path: HANDSHAKE_PATH });

    await promise;
    const readsAtSettle = handshake.readFileCalls;

    // The watcher was already closed, but even a stray callback reference
    // must be inert once the wait is done.
    handshake.lastWatchEvent?.();
    await vi.advanceTimersByTimeAsync(100);

    expect(handshake.readFileCalls).toBe(readsAtSettle);
  });
});

/**
 * Everything above drives the seams directly, which is what makes the
 * scheduling logic deterministic under fake timers. These exercise the base,
 * unmocked implementations against a real temp directory instead, so the
 * `node:fs` calls themselves (not just the logic around them) are covered.
 * Real timers throughout: `fs.watch` events are delivered by the OS, not by
 * vitest's fake clock, so faking timers here would just make the watch path
 * untestable without changing anything the poll-only tests above don't
 * already cover.
 */
describe('SpawnHandshake base seams against a real filesystem', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.useRealTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-spawn-handshake-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("readFile returns a real file's contents", () => {
    const handshake = new RealFsSpawnHandshake();
    const filePath = path.join(tempDir, 'handshake.json');
    fs.writeFileSync(filePath, JSON.stringify({ state: 'ready' }));

    expect(handshake.publicReadFile(filePath)).toBe(JSON.stringify({ state: 'ready' }));
  });

  it('readFile returns undefined rather than throwing when the file does not exist yet', () => {
    const handshake = new RealFsSpawnHandshake();

    expect(handshake.publicReadFile(path.join(tempDir, 'not-written-yet.json'))).toBeUndefined();
  });

  it('watchDirectory returns undefined rather than throwing when the directory does not exist', () => {
    const handshake = new RealFsSpawnHandshake();

    const watch = handshake.publicWatchDirectory(path.join(tempDir, 'does-not-exist'), () => {});

    expect(watch).toBeUndefined();
  });

  /**
   * Deliberately does NOT assert that a real `fs.watch` event ever arrives.
   * An earlier version of this suite waited on that with a generous timeout,
   * and it still failed intermittently (reported independently by two other
   * agents' runs, roughly 1 in a few thousand). That is not a bug in
   * `watchDirectory`: real OS event delivery racing against a machine shared
   * with everything else running concurrently is exactly the kind of
   * unreliability this module's own header says it does not trust watches
   * alone to avoid. Asserting on it directly tests a guarantee the design
   * explicitly refuses to depend on, so it can only ever be a flake generator,
   * never a real regression catcher. What this method actually owns - setting
   * up a watcher and giving back a working `close()` - is what gets asserted;
   * "does the whole wait resolve once a file appears" (which the poll safety
   * net bounds regardless of whether the watch fires) is covered next.
   */
  it('watchDirectory returns a live watcher whose close() does not throw', () => {
    const handshake = new RealFsSpawnHandshake();
    const watch = handshake.publicWatchDirectory(tempDir, () => {});

    expect(watch).toBeDefined();
    expect(() => watch?.close()).not.toThrow();
  });

  it('resolves a real end-to-end wait once the handshake file is written on disk', async () => {
    const handshake = new SpawnHandshake();
    const handshakePath = path.join(tempDir, 'handshake.json');

    // Bounded by the poll safety net (its default is 20ms), not by whether
    // fs.watch happens to fire on this machine right now: this is the
    // behaviour that actually has to be deterministic, and it is, because it
    // does not depend on which of the two paths wins the race. `timeoutMs`
    // is kept well clear of vitest's own per-test timeout so that, if this
    // ever genuinely does not resolve, it fails as an explicit `timed-out`
    // assertion rather than an ambiguous test-runner timeout.
    const { promise } = handshake.waitForHandshake({ path: handshakePath, timeoutMs: 2000 });
    fs.writeFileSync(handshakePath, JSON.stringify({ state: 'ready' }));

    await expect(promise).resolves.toEqual({ status: 'signalled' });
  }, 10_000);
});
