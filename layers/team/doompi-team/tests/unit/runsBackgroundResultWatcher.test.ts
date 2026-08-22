import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBAGENT_RUN_ID_ENV } from '../../src/exports/env';
import { ResultWatcher, type RunResultFile } from '../../src/adapters/resultWatcher';
import type { PollSchedulerContract, PollSubscription } from '../../src/adapters/pollScheduler';

/** Captures whatever `ResultWatcher` registers, without ticking anything on its own. */
class FakeScheduler implements PollSchedulerContract {
  registered: PollSubscription | undefined;
  unregisterCalls = 0;
  wakeCalls = 0;

  register(subscription: PollSubscription): () => void {
    this.registered = subscription;
    return () => {
      this.unregisterCalls += 1;
      this.registered = undefined;
    };
  }

  wake(): void {
    this.wakeCalls += 1;
  }

  start(): void {
    /* not exercised: ResultWatcher never starts the scheduler itself */
  }

  stop(): void {
    /* not exercised */
  }
}

/**
 * Exposes the protected seams over a small in-memory "filesystem" so tests
 * never touch real `node:fs` calls (its ESM namespace is frozen, so
 * `vi.spyOn(fs, ...)` is not an option) while still exercising the exact
 * claim/deliver/dedupe control flow the real seams drive.
 *
 * `resultFiles` stands in for `currentResultsDir()` (keyed by leaf filename) and
 * `claimedFiles` stands in for every run's `claimed-result.json` (keyed by
 * runId), matching the real `claimPathFor`/`resultPathFor` shapes closely
 * enough that `renameFile`/`readFile`/`unlinkFile` can move data between them
 * by inspecting the paths `ResultWatcher` actually builds.
 */
class TestResultWatcher extends ResultWatcher {
  protected override readonly pollIntervalMs = 50;
  protected override readonly dedupeTtlMs = 1000;

  resultFiles = new Map<string, string>();
  claimedFiles = new Map<string, string>();
  ensureDirCalls: string[] = [];
  renameCalls: Array<{ from: string; to: string }> = [];
  unlinkCalls: string[] = [];
  watchCalls = 0;
  /** Set false to simulate a platform where the watch cannot be established. */
  watchSucceeds = true;
  /** Run ids whose claim `readFile` reports as missing, simulating removal between claim and read. */
  vanishedRunIds = new Set<string>();

  protected override listResultFiles(): string[] {
    return [...this.resultFiles.keys()];
  }

  protected override listClaimedRunIds(): string[] {
    return [...this.claimedFiles.keys()];
  }

  protected override ensureDir(dirPath: string): void {
    this.ensureDirCalls.push(dirPath);
  }

  protected override renameFile(fromPath: string, toPath: string): boolean {
    this.renameCalls.push({ from: fromPath, to: toPath });
    const file = path.basename(fromPath);
    const content = this.resultFiles.get(file);
    if (content === undefined) return false; // mirrors real ENOENT: nothing left to claim
    this.resultFiles.delete(file);
    const runId = path.basename(path.dirname(toPath));
    this.claimedFiles.set(runId, content);
    return true;
  }

  protected override readFile(filePath: string): string | undefined {
    const runId = path.basename(path.dirname(filePath));
    if (this.vanishedRunIds.has(runId)) return undefined;
    return this.claimedFiles.get(runId);
  }

  protected override unlinkFile(filePath: string): void {
    this.unlinkCalls.push(filePath);
    const runId = path.basename(path.dirname(filePath));
    this.claimedFiles.delete(runId);
  }

  protected override watchResultsDir(): import('node:fs').FSWatcher | undefined {
    this.watchCalls += 1;
    if (!this.watchSucceeds) return undefined;
    return { close: vi.fn(), unref: vi.fn(), on: vi.fn() } as unknown as import('node:fs').FSWatcher;
  }

  protected override async listResultFilesAsync(): Promise<string[]> {
    return this.listResultFiles();
  }

  protected override async listClaimedRunIdsAsync(): Promise<string[]> {
    return this.listClaimedRunIds();
  }

  protected override async ensureDirAsync(dirPath: string): Promise<void> {
    this.ensureDir(dirPath);
  }

  protected override async renameFileAsync(fromPath: string, toPath: string): Promise<boolean> {
    return this.renameFile(fromPath, toPath);
  }

  protected override async readFileAsync(filePath: string): Promise<string | undefined> {
    return this.readFile(filePath);
  }

  protected override async unlinkFileAsync(filePath: string): Promise<void> {
    this.unlinkFile(filePath);
  }

  protected override async watchResultsDirAsync(): Promise<import('node:fs').FSWatcher | undefined> {
    return this.watchResultsDir();
  }

  // Public wrappers over protected members, the same idiom as
  // `CountingStatusWriter` and `RealFsSpawnHandshake` use elsewhere in this
  // directory's tests.
  runOnce(): Promise<boolean> {
    return this.run();
  }

  publicClaimResult(runId: string, file: string): boolean {
    return this.claimResult(runId, file);
  }

  claimedRunIds(): string[] {
    return [...this.claimedFiles.keys()];
  }

  publicHandleWatchEvent(eventType: 'rename' | 'change', filename: string | null): void {
    this.handleWatchEvent(eventType, filename);
  }
}

class RealFsResultWatcher extends ResultWatcher {
  fileExistsAt(filePath: string): Promise<boolean> {
    return this.fileExistsAsync(filePath);
  }

  readAt(filePath: string): Promise<string | undefined> {
    return this.readFileAsync(filePath);
  }

  ensureAt(dirPath: string): Promise<void> {
    return this.ensureDirAsync(dirPath);
  }

  renameAt(fromPath: string, toPath: string): Promise<boolean> {
    return this.renameFileAsync(fromPath, toPath);
  }

  unlinkAt(filePath: string): Promise<void> {
    return this.unlinkFileAsync(filePath);
  }
}

function seedResult(watcher: TestResultWatcher, runId: string, body: Partial<RunResultFile> = {}): void {
  watcher.resultFiles.set(`${runId}.json`, JSON.stringify({ runId, ...body }));
}

let scheduler: FakeScheduler;
let watcher: TestResultWatcher;

beforeEach(() => {
  vi.useFakeTimers();
  scheduler = new FakeScheduler();
  watcher = new TestResultWatcher(scheduler);
});

afterEach(() => {
  delete process.env[SUBAGENT_RUN_ID_ENV];
  watcher.stop();
  vi.useRealTimers();
});

describe('ResultWatcher claiming', () => {
  it('claims a new result file into the run-scoped claimed-result location', async () => {
    seedResult(watcher, 'run-1');

    const claimedCount = await watcher.runOnce();

    expect(claimedCount).toBe(true);
    expect(watcher.resultFiles.has('run-1.json')).toBe(false);
    expect(watcher.claimedRunIds()).toEqual(['run-1']);
  });

  it('reports no work on a tick where nothing new was found', async () => {
    await expect(watcher.runOnce()).resolves.toBe(false);
  });

  it('does not re-claim a run id it is already tracking', async () => {
    seedResult(watcher, 'run-1');
    await watcher.runOnce();
    watcher.renameCalls = [];

    seedResult(watcher, 'run-1'); // a second producer write under the same name, before delivery
    await watcher.runOnce();

    expect(watcher.renameCalls).toHaveLength(0);
  });

  it('does not claim the result belonging to the current child process', async () => {
    process.env[SUBAGENT_RUN_ID_ENV] = 'own-run';
    seedResult(watcher, 'own-run');

    await expect(watcher.runOnce()).resolves.toBe(false);
    expect(watcher.resultFiles.has('own-run.json')).toBe(true);
    expect(watcher.claimedRunIds()).toEqual([]);
  });
});

describe(
  "ResultWatcher's fs.watch event filter (fix: the predecessor only handled 'rename' and missed a result " +
    'file rewritten in place)',
  () => {
    // Deterministic on purpose: `fs.watch` gives no delivery guarantee at
    // all, so a test that waits for a real OS event to arrive within some
    // timeout is testing the OS's scheduler, not this filter. Calling the
    // extracted `handleWatchEvent` directly with synthetic event types
    // proves the filter treats 'change' and 'rename' identically without
    // depending on whether, or when, the OS actually delivers one.
    it("wakes the scheduler for a 'rename' event on a candidate result file", () => {
      watcher.publicHandleWatchEvent('rename', 'run-1.json');
      expect(scheduler.wakeCalls).toBe(1);
    });

    it("wakes the scheduler for a 'change' event on a candidate result file just as much as for 'rename'", () => {
      watcher.publicHandleWatchEvent('change', 'run-1.json');
      expect(scheduler.wakeCalls).toBe(1);
    });

    it('ignores an event whose filename does not look like a result file', () => {
      watcher.publicHandleWatchEvent('change', 'not-a-result.txt');
      expect(scheduler.wakeCalls).toBe(0);
    });

    it('ignores an event with no filename at all (some platforms omit it)', () => {
      watcher.publicHandleWatchEvent('change', null);
      expect(scheduler.wakeCalls).toBe(0);
    });
  },
);

describe('ResultWatcher delivery', () => {
  it('hands the claimed result, with its runId, to the registered consumer', async () => {
    seedResult(watcher, 'run-1', { summary: 'done' });
    const consumer = vi.fn().mockResolvedValue(true);
    watcher.start(consumer);

    await watcher.runOnce();
    await vi.waitFor(() => expect(consumer).toHaveBeenCalledTimes(1));

    expect(consumer).toHaveBeenCalledWith({ runId: 'run-1', summary: 'done' });
  });

  it('removes the claimed copy once the consumer accepts the result', async () => {
    seedResult(watcher, 'run-1');
    watcher.start(vi.fn().mockResolvedValue(true));

    await watcher.runOnce();
    await vi.waitFor(() => expect(watcher.claimedRunIds()).toEqual([]));

    expect(watcher.unlinkCalls).toHaveLength(1);
  });

  it('keeps the claim and retries on the next tick when the consumer is not ready to accept it yet', async () => {
    seedResult(watcher, 'run-1');
    const consumer = vi.fn().mockResolvedValue(false);
    watcher.start(consumer);

    await watcher.runOnce();
    await vi.waitFor(() => expect(consumer).toHaveBeenCalledTimes(1));
    expect(watcher.claimedRunIds()).toEqual(['run-1']); // not discarded

    await watcher.runOnce(); // next tick retries
    await vi.waitFor(() => expect(consumer).toHaveBeenCalledTimes(2));
  });

  it('does not fire the consumer a second time while a delivery attempt is still outstanding', async () => {
    seedResult(watcher, 'run-1');
    const consumer = vi.fn(() => new Promise<boolean>(() => {})); // never resolves
    watcher.start(consumer);

    await watcher.runOnce();
    await watcher.runOnce();
    await watcher.runOnce();

    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('keeps the claim for retry and records the failure when the consumer itself throws', async () => {
    seedResult(watcher, 'run-1');
    const consumer = vi.fn().mockRejectedValue(new Error('consumer exploded'));
    watcher.start(consumer);

    await watcher.runOnce();
    await vi.waitFor(() => expect(watcher.processingErrorCount).toBe(1));

    expect(watcher.claimedRunIds()).toEqual(['run-1']);
    expect(watcher.lastProcessingError?.id).toBe('run-1');
  });

  it('discards a claim whose contents cannot be parsed as JSON, recording the failure', async () => {
    watcher.resultFiles.set('run-1.json', '{not json');
    watcher.start(vi.fn());

    await watcher.runOnce();
    await vi.waitFor(() => expect(watcher.claimedRunIds()).toEqual([]));

    expect(watcher.processingErrorCount).toBe(1);
    expect(watcher.lastProcessingError?.id).toBe('run-1');
  });

  it('stops tracking a claim once its file has vanished before delivery could read it, instead of retrying it forever', async () => {
    seedResult(watcher, 'run-1');
    watcher.vanishedRunIds.add('run-1'); // simulates removal between the claim and the read
    const consumer = vi.fn();
    watcher.start(consumer);

    await watcher.runOnce(); // claims run-1, then finds it vanished on read and drops it from tracking

    expect(consumer).not.toHaveBeenCalled();
    // If tracking had not been dropped, discoverAndClaim's "already tracking
    // this run id" guard would silently skip a fresh write under the same
    // name forever. Reclaiming it here is the observable proof it was dropped.
    watcher.vanishedRunIds.delete('run-1');
    seedResult(watcher, 'run-1');

    await expect(watcher.runOnce()).resolves.toBe(true);
  });

  it('discards a claim whose JSON parses to something other than an object, such as a bare number', async () => {
    watcher.resultFiles.set('run-1.json', JSON.stringify(42));
    watcher.start(vi.fn());

    await watcher.runOnce();

    await vi.waitFor(() => expect(watcher.claimedRunIds()).toEqual([]));
  });

  it('discards a claim whose JSON parses to null', async () => {
    watcher.resultFiles.set('run-1.json', 'null');
    watcher.start(vi.fn());

    await watcher.runOnce();

    await vi.waitFor(() => expect(watcher.claimedRunIds()).toEqual([]));
  });
});

describe('ResultWatcher TTL dedupe (fix: the predecessor had two drifting implementations of this check)', () => {
  it('drops a result for a run id delivered less than dedupeTtlMs ago instead of redelivering it', async () => {
    seedResult(watcher, 'run-1');
    const consumer = vi.fn().mockResolvedValue(true);
    watcher.start(consumer);
    await watcher.runOnce();
    await vi.waitFor(() => expect(consumer).toHaveBeenCalledTimes(1));

    // A second producer write for the same run, arriving inside the TTL window.
    seedResult(watcher, 'run-1');
    await watcher.runOnce();
    await vi.waitFor(() => expect(watcher.claimedRunIds()).toEqual([]));

    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it('delivers a result again once the dedupe TTL has expired', async () => {
    seedResult(watcher, 'run-1');
    const consumer = vi.fn().mockResolvedValue(true);
    watcher.start(consumer);
    await watcher.runOnce();
    await vi.waitFor(() => expect(consumer).toHaveBeenCalledTimes(1));

    vi.setSystemTime(Date.now() + 2000); // past the 1000ms test dedupeTtlMs
    seedResult(watcher, 'run-1');
    await watcher.runOnce();

    await vi.waitFor(() => expect(consumer).toHaveBeenCalledTimes(2));
  });

  it('caps tracked deliveries, evicting the oldest so it can be delivered again rather than growing without bound', async () => {
    const consumer = vi.fn().mockResolvedValue(true);
    watcher.start(consumer);

    // One more than MAX_TRACKED_DELIVERIES (256): the 257th successful
    // delivery must evict the oldest tracked id (run-0) to stay bounded.
    for (let i = 0; i < 257; i++) {
      seedResult(watcher, `run-${i}`);
      await watcher.runOnce();
      await Promise.resolve();
      await Promise.resolve();
    }

    consumer.mockClear();
    seedResult(watcher, 'run-0'); // a second write for the evicted id
    await watcher.runOnce();
    await vi.waitFor(() => expect(consumer).toHaveBeenCalledWith({ runId: 'run-0' }));
  });
});

describe('ResultWatcher atomic claim (fix: the predecessor checked existence then unlinked as two separate steps)', () => {
  it('lets only one of two racing claim attempts for the same file succeed, without throwing', () => {
    seedResult(watcher, 'run-1');

    const first = watcher.publicClaimResult('run-1', 'run-1.json');
    const second = watcher.publicClaimResult('run-1', 'run-1.json');

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('delivers a result exactly once when two watchers race to claim and deliver the same file', async () => {
    // Two independent watchers sharing one underlying "disk", standing in for
    // two processes (or two ticks) racing on the same currentResultsDir() entry.
    const schedulerA = new FakeScheduler();
    const schedulerB = new FakeScheduler();
    const watcherA = new TestResultWatcher(schedulerA);
    const watcherB = new TestResultWatcher(schedulerB);
    watcherA.resultFiles = watcherB.resultFiles = new Map([['run-1.json', JSON.stringify({ runId: 'run-1' })]]);
    watcherA.claimedFiles = watcherB.claimedFiles = new Map();

    const consumerA = vi.fn().mockResolvedValue(true);
    const consumerB = vi.fn().mockResolvedValue(true);
    watcherA.start(consumerA);
    watcherB.start(consumerB);

    await Promise.all([watcherA.runOnce(), watcherB.runOnce()]);
    await vi.waitFor(() => expect(consumerA.mock.calls.length + consumerB.mock.calls.length).toBe(1));

    expect(consumerA.mock.calls.length + consumerB.mock.calls.length).toBe(1);
  });
});

describe('ResultWatcher owns no timer (fix: the predecessor stored setTimeout as if it returned a number)', () => {
  it('never schedules a setTimeout or setInterval of its own across start, a tick, and stop', async () => {
    seedResult(watcher, 'run-1');
    watcher.start(vi.fn().mockResolvedValue(true));

    await watcher.runOnce();
    watcher.stop();

    // Every timer this test could observe belongs to something else (there is
    // none registered here): ResultWatcher delegates all scheduling to
    // PollScheduler and reacts to fs.watch, and owns no Timeout handle itself.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ResultWatcher <-> PollScheduler registration (watch-first, poll as a bounded safety net)', () => {
  it('registers exactly one subscriber on start and defers fs.watch setup to the async tick', async () => {
    watcher.start(vi.fn());

    expect(scheduler.registered?.id).toBe('result-watcher');
    expect(scheduler.registered?.intervalMs).toBe(50);
    expect(watcher.watchCalls).toBe(0);

    await watcher.runOnce();
    expect(watcher.watchCalls).toBe(1);
  });

  it("drives claiming through the exact callback PollScheduler would call, not just through the test's own runOnce() wrapper", async () => {
    seedResult(watcher, 'run-1');
    watcher.start(vi.fn());

    const workHappened = await scheduler.registered?.run();

    expect(workHappened).toBe(true);
    expect(watcher.claimedRunIds()).toEqual(['run-1']);
  });

  it('unregisters from the scheduler on stop', () => {
    watcher.start(vi.fn());
    watcher.stop();

    expect(scheduler.unregisterCalls).toBe(1);
  });

  it('re-attempts establishing the watch on the next tick after it failed to start', async () => {
    watcher.watchSucceeds = false;
    watcher.start(vi.fn());
    expect(watcher.watchCalls).toBe(0);

    await watcher.runOnce();
    await watcher.runOnce();

    expect(watcher.watchCalls).toBe(2);
  });

  it('replaces the previous consumer on a second start(), the same reset idiom as CoalescedStatusWriter.open, so a still-outstanding delivery from the old session cannot reach it', async () => {
    seedResult(watcher, 'run-1');
    const oldConsumer = vi.fn(() => new Promise<boolean>(() => {})); // never resolves
    watcher.start(oldConsumer);
    await watcher.runOnce();
    expect(oldConsumer).toHaveBeenCalledTimes(1);

    const newConsumer = vi.fn().mockResolvedValue(true);
    watcher.start(newConsumer); // reset: in-memory tracking for the stale in-flight claim above is dropped

    seedResult(watcher, 'run-2');
    await watcher.runOnce();
    await vi.waitFor(() => expect(newConsumer).toHaveBeenCalledWith({ runId: 'run-2' }));

    expect(oldConsumer).toHaveBeenCalledTimes(1); // never called again after the reset
  });
});

describe('ResultWatcher orphan recovery', () => {
  it('picks up a claimed-but-undelivered result left behind by a previous process, on start', async () => {
    watcher.claimedFiles.set('crashed-run', JSON.stringify({ runId: 'crashed-run' }));
    const consumer = vi.fn().mockResolvedValue(true);

    watcher.start(consumer);
    await watcher.runOnce();

    await vi.waitFor(() => expect(consumer).toHaveBeenCalledWith({ runId: 'crashed-run' }));
  });
});

describe('ResultWatcher promise-based filesystem seams', () => {
  it('handles existing, missing, moved, removed, and invalid paths without blocking', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-result-watcher-'));
    const realWatcher = new RealFsResultWatcher(new FakeScheduler());
    const source = path.join(tempDir, 'source.json');
    const destination = path.join(tempDir, 'nested', 'destination.json');
    fs.writeFileSync(source, '{"ok":true}');

    try {
      await expect(realWatcher.fileExistsAt(source)).resolves.toBe(true);
      await expect(realWatcher.fileExistsAt(`${source}.missing`)).resolves.toBe(false);
      await expect(realWatcher.readAt(source)).resolves.toBe('{"ok":true}');
      await expect(realWatcher.readAt(`${source}.missing`)).resolves.toBeUndefined();
      await expect(realWatcher.readAt(tempDir)).rejects.toBeInstanceOf(Error);

      await realWatcher.ensureAt(path.dirname(destination));
      await expect(realWatcher.renameAt(source, destination)).resolves.toBe(true);
      await expect(realWatcher.renameAt(source, destination)).resolves.toBe(false);

      await realWatcher.unlinkAt(destination);
      await realWatcher.unlinkAt(destination);
      await realWatcher.unlinkAt(path.dirname(destination));
      expect(realWatcher.processingErrorCount).toBe(1);
    } finally {
      realWatcher.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
