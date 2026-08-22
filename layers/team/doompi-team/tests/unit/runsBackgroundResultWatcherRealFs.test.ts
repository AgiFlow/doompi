import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResultWatcher } from '../../src/adapters/resultWatcher';
import { currentResultsDir, currentRunsDir } from '../../src/adapters/filesystem/paths';

/**
 * Exercises `watchResultsDir()`'s base (real `node:fs.watch`) implementation
 * against the actual `currentResultsDir()` (a fixed, shared path from
 * `shared/paths.ts`, not injectable per test - every test below uses a
 * unique run id and cleans up its own files).
 *
 * DELIBERATELY NOT TIMING-BASED:
 * `fs.watch` gives no delivery guarantee - not that an event fires, and not
 * when. A test that waits on a real OS event to arrive within some timeout is
 * testing the OS's scheduler, not this code, and is exactly the kind of test
 * that passes in isolation and flakes under load (this package's own
 * `spawnHandshake.ts` test suite had one removed for the same reason). The
 * actual event-filtering logic (fix 1: 'change' is handled the same as
 * 'rename') is covered deterministically in
 * `runsBackgroundResultWatcher.test.ts` by calling the extracted
 * `handleWatchEvent` directly with synthetic event types. What's left to
 * prove here, without depending on OS timing, is only the structural facts:
 * a real watch can be established against the real directory, and a failure
 * to establish one is swallowed rather than thrown.
 */
class RealFsResultWatcher extends ResultWatcher {
  publicWatchResultsDir(): fs.FSWatcher | undefined {
    return this.watchResultsDir();
  }

  publicReadFile(filePath: string): string | undefined {
    return this.readFile(filePath);
  }

  publicRenameFile(fromPath: string, toPath: string): boolean {
    return this.renameFile(fromPath, toPath);
  }

  publicUnlinkFile(filePath: string): void {
    this.unlinkFile(filePath);
  }

  publicEnsureDir(dirPath: string): void {
    this.ensureDir(dirPath);
  }

  publicFileExists(filePath: string): boolean {
    return this.fileExists(filePath);
  }

  publicListResultFiles(): string[] {
    return this.listResultFiles();
  }

  publicListClaimedRunIds(): string[] {
    return this.listClaimedRunIds();
  }

  publicHandleWatchError(): void {
    this.handleWatchError();
  }

  publicGetWatcher(): fs.FSWatcher | undefined {
    return this.getWatcher();
  }

  setWatcher(watcher: fs.FSWatcher): void {
    // Test-only: seeds the private field the same way watchResultsDir()
    // itself would, so handleWatchError()'s effect on it is observable.
    (this as unknown as { watcher: fs.FSWatcher | undefined }).watcher = watcher;
  }
}

class FakeScheduler {
  wakeCalls = 0;
  register(): () => void {
    return () => {};
  }
  wake(): void {
    this.wakeCalls += 1;
  }
  start(): void {}
  stop(): void {}
}

function freshRunId(label: string): string {
  return `result-watcher-real-fs-${label}-${Math.random().toString(36).slice(2)}`;
}

describe('ResultWatcher.watchResultsDir against a real filesystem', () => {
  let watchHandle: fs.FSWatcher | undefined;

  afterEach(() => {
    // Always closed before the test returns: a leaked real watcher on the
    // shared currentResultsDir() would keep firing into whatever test file runs next.
    watchHandle?.close();
    watchHandle = undefined;
  });

  it('establishes a real fs.FSWatcher against currentResultsDir() without throwing', () => {
    const scheduler = new FakeScheduler();
    const watcher = new RealFsResultWatcher(scheduler as unknown as ConstructorParameters<typeof ResultWatcher>[0]);

    watchHandle = watcher.publicWatchResultsDir();

    expect(watchHandle).toBeDefined();
    expect(typeof watchHandle?.close).toBe('function');
  });

  it('returns undefined rather than throwing when the directory cannot be watched', () => {
    // Passes through the same seam a permission error or an unsupported
    // mount would hit: ensureDir() failing must not propagate out of
    // watchResultsDir(), because the poll safety net (PollScheduler) exists
    // for exactly this case.
    class UnwatchableResultWatcher extends RealFsResultWatcher {
      protected override ensureDir(): void {
        throw new Error('simulated: directory could not be created');
      }
    }
    const scheduler = new FakeScheduler();
    const unwatchable = new UnwatchableResultWatcher(
      scheduler as unknown as ConstructorParameters<typeof ResultWatcher>[0],
    );

    expect(unwatchable.publicWatchResultsDir()).toBeUndefined();
  });
});

describe('run-scoped claim location under currentRunsDir()', () => {
  it('is inside the run directory, not inside currentResultsDir(), so ResultWatcher cannot observe its own claim writes', () => {
    const runId = freshRunId('claim-location');
    const claimPath = path.join(currentRunsDir(), runId, 'claimed-result.json');

    expect(claimPath.startsWith(currentResultsDir())).toBe(false);
  });
});

/**
 * Exercises the base (real `node:fs`) bodies of the four seams that take an
 * explicit path argument - `readFile`, `renameFile`, `unlinkFile`,
 * `ensureDir` - against a private `mkdtemp` directory of their own.
 *
 * Deliberately NOT against `currentResultsDir()`/`currentRunsDir()`: those are fixed, shared
 * paths that other test files also read and write concurrently, which is
 * exactly the kind of shared state that caused this suite's earlier
 * cross-file interference. These four seams take their target path as an
 * argument rather than reading a module constant, so they can be proven
 * correct against a directory nothing else on the machine touches.
 */
describe('ResultWatcher path-taking fs seams against an isolated real filesystem', () => {
  let tempDir: string;
  let watcher: RealFsResultWatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-result-watcher-'));
    watcher = new RealFsResultWatcher(new FakeScheduler() as unknown as ConstructorParameters<typeof ResultWatcher>[0]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("readFile returns a real file's contents", () => {
    const filePath = path.join(tempDir, 'claimed-result.json');
    fs.writeFileSync(filePath, JSON.stringify({ runId: 'x' }));

    expect(watcher.publicReadFile(filePath)).toBe(JSON.stringify({ runId: 'x' }));
  });

  it('readFile returns undefined rather than throwing when the file does not exist', () => {
    expect(watcher.publicReadFile(path.join(tempDir, 'missing.json'))).toBeUndefined();
  });

  it('renameFile moves a real file and returns true', () => {
    const fromPath = path.join(tempDir, 'source.json');
    const toPath = path.join(tempDir, 'dest.json');
    fs.writeFileSync(fromPath, 'content');

    expect(watcher.publicRenameFile(fromPath, toPath)).toBe(true);
    expect(fs.existsSync(fromPath)).toBe(false);
    expect(fs.readFileSync(toPath, 'utf-8')).toBe('content');
  });

  it('renameFile returns false rather than throwing when the source no longer exists (the claim-race outcome, fix 4)', () => {
    const fromPath = path.join(tempDir, 'already-claimed.json');
    const toPath = path.join(tempDir, 'dest.json');

    expect(watcher.publicRenameFile(fromPath, toPath)).toBe(false);
  });

  it('lets a non-ENOENT renameFile failure propagate, rather than mistaking it for a lost claim race', () => {
    const fromPath = path.join(tempDir, 'source.json');
    fs.writeFileSync(fromPath, 'content');
    // A parent path component that is a plain file, not a directory, is a
    // reliable way to provoke a real ENOTDIR - a genuine failure, unlike the
    // ENOENT that just means "someone else already claimed it".
    const fileAsDir = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(fileAsDir, 'x');
    const toPath = path.join(fileAsDir, 'dest.json');

    expect(() => watcher.publicRenameFile(fromPath, toPath)).toThrow();
  });

  it('unlinkFile removes a real file', () => {
    const filePath = path.join(tempDir, 'to-remove.json');
    fs.writeFileSync(filePath, 'content');

    watcher.publicUnlinkFile(filePath);

    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('unlinkFile swallows a missing file rather than throwing or recording it as a processing error', () => {
    watcher.publicUnlinkFile(path.join(tempDir, 'never-existed.json'));

    expect(watcher.processingErrorCount).toBe(0);
  });

  it('unlinkFile records a non-ENOENT failure as a processing error rather than throwing', () => {
    // A directory can be created but not unlinked with unlinkSync, which is a
    // reliable way to provoke a real, non-ENOENT fs error without touching
    // permissions.
    const dirPath = path.join(tempDir, 'a-directory');
    fs.mkdirSync(dirPath);

    watcher.publicUnlinkFile(dirPath);

    expect(watcher.processingErrorCount).toBe(1);
    expect(watcher.lastProcessingError?.id).toBe(dirPath);
  });

  it('ensureDir creates a real, possibly-nested directory', () => {
    const nestedDir = path.join(tempDir, 'a', 'b', 'c');

    watcher.publicEnsureDir(nestedDir);

    expect(fs.statSync(nestedDir).isDirectory()).toBe(true);
  });

  it('ensureDir is a no-op, not an error, when the directory already exists', () => {
    watcher.publicEnsureDir(tempDir);

    expect(() => watcher.publicEnsureDir(tempDir)).not.toThrow();
  });

  it('lets a non-ENOENT readFile failure propagate, rather than mistaking it for "not written yet"', () => {
    // Reading a directory as a file is a reliable, portable way to provoke a
    // real EISDIR without touching permissions.
    expect(() => watcher.publicReadFile(tempDir)).toThrow();
  });

  it('fileExists reports true for a real file and false for one that does not exist', () => {
    const filePath = path.join(tempDir, 'present.json');
    fs.writeFileSync(filePath, '{}');

    expect(watcher.publicFileExists(filePath)).toBe(true);
    expect(watcher.publicFileExists(path.join(tempDir, 'absent.json'))).toBe(false);
  });

  it("handleWatchError drops the tracked watcher, so run()'s next tick re-establishes it", () => {
    const fakeWatcher = { close: () => {} } as fs.FSWatcher;
    watcher.setWatcher(fakeWatcher);
    expect(watcher.publicGetWatcher()).toBe(fakeWatcher);

    watcher.publicHandleWatchError();

    expect(watcher.publicGetWatcher()).toBeUndefined();
  });
});

/**
 * `listResultFiles`/`listClaimedRunIds` are hardcoded to the real, shared
 * `currentResultsDir()`/`currentRunsDir()` (they read a directory-wide listing, not one path
 * a caller supplies), so unlike the seams above they cannot be redirected to
 * an isolated temp directory. What is safe to prove without disturbing
 * anything: a read-only listing against directories other tests are already
 * populating succeeds and returns an array. Provoking their ENOENT branch
 * would mean deleting `currentResultsDir()`/`currentRunsDir()` out from under every other
 * test file sharing this process - the exact cross-file interference this
 * suite has already been bitten by once - so that branch is deliberately
 * left to the (identical, well-covered elsewhere) `isNotFound` helper rather
 * than forced here.
 */
describe('ResultWatcher directory-listing seams against the real, shared currentResultsDir()/currentRunsDir()', () => {
  it('listResultFiles returns an array without throwing against the real, populated currentResultsDir()', () => {
    const watcher = new RealFsResultWatcher(
      new FakeScheduler() as unknown as ConstructorParameters<typeof ResultWatcher>[0],
    );

    expect(Array.isArray(watcher.publicListResultFiles())).toBe(true);
  });

  it('listClaimedRunIds returns an array without throwing against the real, populated currentRunsDir()', () => {
    const watcher = new RealFsResultWatcher(
      new FakeScheduler() as unknown as ConstructorParameters<typeof ResultWatcher>[0],
    );

    expect(Array.isArray(watcher.publicListClaimedRunIds())).toBe(true);
  });
});
