import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RunIdResolver } from '../../src/adapters/runIdResolver';
import { currentResultsDir, currentRunsDir } from '../../src/adapters/filesystem/paths';

/**
 * Exposes the protected filesystem seams over in-memory state, the same
 * idiom as `TestSpawnHandshake` / `TestResultWatcher`: `RunIdResolver` reads
 * fixed paths derived from `currentRunsDir()`/`currentResultsDir()`, so its seams are
 * overridden at the "what exists" level rather than touching real `node:fs`.
 */
class TestRunIdResolver extends RunIdResolver {
  runDirs = new Set<string>();
  pendingResultIds = new Set<string>();
  claimedResultIds = new Set<string>();

  protected override listRunDirNames(): string[] {
    return [...this.runDirs];
  }

  protected override listPendingResultIds(): string[] {
    return [...this.pendingResultIds];
  }

  protected override pathExists(filePath: string): boolean {
    if (filePath.endsWith('claimed-result.json')) {
      const runId = filePath.split('/').at(-2);
      return runId !== undefined && this.claimedResultIds.has(runId);
    }
    if (filePath.endsWith('.json')) {
      const leaf = filePath.split('/').at(-1) ?? '';
      return this.pendingResultIds.has(leaf.slice(0, -'.json'.length));
    }
    // Anything else is a run directory path.
    const runId = filePath.split('/').at(-1);
    return runId !== undefined && this.runDirs.has(runId);
  }
}

describe('RunIdResolver exact matches', () => {
  it('resolves a run with only a run directory (still running, no result yet)', () => {
    const resolver = new TestRunIdResolver();
    resolver.runDirs.add('run-1');

    const resolved = resolver.resolve('run-1');

    expect(resolved).toMatchObject({ runId: 'run-1', claimed: false });
    expect(resolved?.resultPath).toBeUndefined();
  });

  it('resolves a run whose result is still pending in currentResultsDir()', () => {
    const resolver = new TestRunIdResolver();
    resolver.runDirs.add('run-1');
    resolver.pendingResultIds.add('run-1');

    const resolved = resolver.resolve('run-1');

    expect(resolved?.claimed).toBe(false);
    expect(resolved?.resultPath).toContain('run-1.json');
  });

  it('resolves to the claimed copy, not the (now nonexistent) pending path, once ResultWatcher has claimed the result', () => {
    const resolver = new TestRunIdResolver();
    resolver.runDirs.add('run-1');
    resolver.claimedResultIds.add('run-1');
    // Deliberately does not add 'run-1' to pendingResultIds: claiming moves
    // the file, so a real claimed run would no longer have a currentResultsDir() entry.

    const resolved = resolver.resolve('run-1');

    expect(resolved?.claimed).toBe(true);
    expect(resolved?.resultPath).toContain('claimed-result.json');
  });

  it('returns undefined for an id that matches nothing at all', () => {
    const resolver = new TestRunIdResolver();

    expect(resolver.resolve('does-not-exist')).toBeUndefined();
  });
});

describe('RunIdResolver prefix matches', () => {
  it('resolves an unambiguous prefix the same as an exact id', () => {
    const resolver = new TestRunIdResolver();
    resolver.runDirs.add('run-abc123');

    const resolved = resolver.resolve('run-abc');

    expect(resolved?.runId).toBe('run-abc123');
  });

  it('throws, naming every match, when a prefix matches more than one run id', () => {
    const resolver = new TestRunIdResolver();
    resolver.runDirs.add('run-abc111');
    resolver.runDirs.add('run-abc222');

    expect(() => resolver.resolve('run-abc')).toThrow(/run-abc111.*run-abc222|run-abc222.*run-abc111/s);
  });

  it('returns undefined, not an error, when a prefix matches nothing', () => {
    const resolver = new TestRunIdResolver();
    resolver.runDirs.add('run-abc123');

    expect(resolver.resolve('zzz')).toBeUndefined();
  });

  it('considers both run directories and pending result files as prefix candidates', () => {
    const resolver = new TestRunIdResolver();
    // Only a pending result, no run directory left (e.g. a very short-lived
    // async run whose working directory was already cleaned up).
    resolver.pendingResultIds.add('run-xyz789');

    const resolved = resolver.resolve('run-xyz');

    expect(resolved?.runId).toBe('run-xyz789');
  });
});

/**
 * Exercises the base (real `node:fs`) seam implementations directly, against
 * the actual `currentRunsDir()`/`currentResultsDir()` (fixed, shared paths, not injectable
 * per test - see `statusWriter.test.ts` for the same approach). Each test
 * uses a unique run id and cleans up its own files.
 */
describe('RunIdResolver base seams against a real filesystem', () => {
  const createdRunIds: string[] = [];

  function freshRunId(label: string): string {
    const runId = `run-id-resolver-${label}-${Math.random().toString(36).slice(2)}`;
    createdRunIds.push(runId);
    return runId;
  }

  afterEach(() => {
    while (createdRunIds.length > 0) {
      const runId = createdRunIds.pop();
      if (!runId) continue;
      fs.rmSync(path.join(currentRunsDir(), runId), { recursive: true, force: true });
      fs.rmSync(path.join(currentResultsDir(), `${runId}.json`), { force: true });
    }
  });

  it('resolves a real run directory written to currentRunsDir()', () => {
    const runId = freshRunId('real-dir');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });

    const resolved = new RunIdResolver().resolve(runId);

    expect(resolved).toMatchObject({ runId, claimed: false });
    expect(resolved?.runDir).toBe(path.join(currentRunsDir(), runId));
  });

  it('resolves a real pending result file written to currentResultsDir()', () => {
    const runId = freshRunId('real-result');
    fs.mkdirSync(currentResultsDir(), { recursive: true });
    fs.writeFileSync(path.join(currentResultsDir(), `${runId}.json`), JSON.stringify({ runId }));

    const resolved = new RunIdResolver().resolve(runId);

    expect(resolved).toMatchObject({
      runId,
      claimed: false,
      resultPath: path.join(currentResultsDir(), `${runId}.json`),
    });
  });

  it('resolves a real claimed-result.json written by ResultWatcher', () => {
    const runId = freshRunId('real-claimed');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });
    fs.writeFileSync(path.join(currentRunsDir(), runId, 'claimed-result.json'), JSON.stringify({ runId }));

    const resolved = new RunIdResolver().resolve(runId);

    expect(resolved).toMatchObject({ claimed: true });
  });

  it('resolves an unambiguous prefix against real directory listings', () => {
    const runId = freshRunId('real-prefix-abc');
    fs.mkdirSync(path.join(currentRunsDir(), runId), { recursive: true });

    const resolved = new RunIdResolver().resolve(runId.slice(0, -4));

    expect(resolved?.runId).toBe(runId);
  });

  it('returns undefined for an id that matches nothing on a real, populated currentRunsDir()/currentResultsDir()', () => {
    freshRunId('real-unrelated'); // ensures currentRunsDir()/currentResultsDir() exist and are non-empty for this test

    expect(new RunIdResolver().resolve('definitely-not-a-real-run-id-000')).toBeUndefined();
  });

  it('resolves every exact storage state through promise-based filesystem discovery', async () => {
    const directoryOnly = freshRunId('async-directory');
    const pending = freshRunId('async-pending');
    const claimed = freshRunId('async-claimed');
    fs.mkdirSync(path.join(currentRunsDir(), directoryOnly), { recursive: true });
    fs.mkdirSync(path.join(currentResultsDir()), { recursive: true });
    fs.writeFileSync(path.join(currentResultsDir(), `${pending}.json`), '{}');
    fs.mkdirSync(path.join(currentRunsDir(), claimed), { recursive: true });
    fs.writeFileSync(path.join(currentRunsDir(), claimed, 'claimed-result.json'), '{}');
    const resolver = new RunIdResolver();

    await expect(resolver.resolveAsync(directoryOnly)).resolves.toMatchObject({
      runId: directoryOnly,
      claimed: false,
      resultPath: undefined,
    });
    await expect(resolver.resolveAsync(pending)).resolves.toMatchObject({ runId: pending, claimed: false });
    await expect(resolver.resolveAsync(claimed)).resolves.toMatchObject({ runId: claimed, claimed: true });
    await expect(resolver.resolveAsync('definitely-not-a-real-async-run-id-000')).resolves.toBeUndefined();
  });

  it('resolves an unambiguous async prefix and rejects an ambiguous one', async () => {
    const prefix = freshRunId('async-prefix');
    const first = `${prefix}-first`;
    const second = `${prefix}-second`;
    createdRunIds.push(first, second);
    fs.mkdirSync(path.join(currentRunsDir(), first), { recursive: true });
    const resolver = new RunIdResolver();

    await expect(resolver.resolveAsync(prefix)).resolves.toMatchObject({ runId: first });

    fs.mkdirSync(path.join(currentRunsDir(), second), { recursive: true });
    await expect(resolver.resolveAsync(prefix)).rejects.toThrow(/Ambiguous run id prefix/);
  });
});

/**
 * Exercises `listRunDirNames`/`listPendingResultIds`'s `isNotFound` branch
 * for real, by pointing the `runsDir()`/`resultsDir()` seams at a directory
 * that genuinely does not exist. This is the same pattern
 * `AgentDiscoveryService` uses for `now()`/`load()`: a protected method, not
 * a constructor argument, is what inversify-bound classes use for anything a
 * test needs to redirect. Because these two seams take no path from the
 * caller, this is also what makes the branch testable at all without
 * deleting the real, shared `currentRunsDir()`/`currentResultsDir()` out from under whatever
 * else is running concurrently in this process.
 */
class MissingDirRunIdResolver extends RunIdResolver {
  constructor(private readonly missingDir: string) {
    super();
  }

  protected override runsDir(): string {
    return this.missingDir;
  }

  protected override resultsDir(): string {
    return this.missingDir;
  }
}

describe('RunIdResolver directory-listing seams when the directory does not exist', () => {
  it('listRunDirNames (via a prefix lookup) returns no candidates instead of throwing when currentRunsDir() is missing', () => {
    const missingDir = path.join(currentRunsDir(), `definitely-does-not-exist-${Math.random().toString(36).slice(2)}`);
    const resolver = new MissingDirRunIdResolver(missingDir);

    // A prefix lookup is what actually calls listRunDirNames/listPendingResultIds.
    expect(resolver.resolve('any-prefix')).toBeUndefined();
  });

  it('does not throw when both directories are missing, proving both isNotFound branches return cleanly', async () => {
    const missingDir = path.join(os.tmpdir(), `run-id-resolver-missing-${Math.random().toString(36).slice(2)}`);
    const resolver = new MissingDirRunIdResolver(missingDir);

    expect(() => resolver.resolve('anything')).not.toThrow();
    await expect(resolver.resolveAsync('anything')).resolves.toBeUndefined();
  });
});

/**
 * The success path of `listRunDirNames`/`listPendingResultIds` against an
 * isolated `mkdtemp` directory of its own - same reasoning as
 * `MissingDirRunIdResolver` above: deterministic, and untangled from
 * whatever else happens to exist in the real, shared `currentRunsDir()`/`currentResultsDir()`
 * at the moment this test happens to run.
 */
class FixedDirRunIdResolver extends RunIdResolver {
  constructor(private readonly dir: string) {
    super();
  }

  protected override runsDir(): string {
    return this.dir;
  }

  protected override resultsDir(): string {
    return this.dir;
  }
}

describe('RunIdResolver directory-listing seams against an isolated real filesystem', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists real run directory names and real pending result ids from a populated directory', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-id-resolver-fixed-'));
    fs.mkdirSync(path.join(tempDir, 'run-a'));
    fs.writeFileSync(path.join(tempDir, 'run-b.json'), '{}');
    fs.writeFileSync(path.join(tempDir, 'not-a-run-dir.txt'), 'ignored');
    const resolver = new FixedDirRunIdResolver(tempDir);

    // Prefix "run-" matches both the real directory entry and the real result file.
    expect(() => resolver.resolve('run-')).toThrow(/run-a.*run-b|run-b.*run-a/s);
    await expect(resolver.resolveAsync('run-')).rejects.toThrow(/run-a.*run-b|run-b.*run-a/s);
  });

  it('lets a non-ENOENT listing failure propagate, rather than mistaking it for "does not exist"', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-id-resolver-fixed-'));
    // A plain file used as if it were a directory reliably provokes a real,
    // non-ENOENT error (ENOTDIR) from readdirSync.
    const fileNotDir = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(fileNotDir, 'x');
    const resolver = new FixedDirRunIdResolver(fileNotDir);

    expect(() => resolver.resolve('anything')).toThrow();
    await expect(resolver.resolveAsync('anything')).rejects.toBeInstanceOf(Error);
  });
});
