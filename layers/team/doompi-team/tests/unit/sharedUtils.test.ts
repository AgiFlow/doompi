import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAtomicJsonWriter,
  writeAtomicJson,
  writeAtomicJsonAsync,
  writePrivateAtomicJson,
} from '../../src/adapters/atomicJson';
import { BoundedKeySet } from '../../src/services/support/boundedKeySet';
import {
  DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
  delayForFileSystemRetry,
  isRetryableFileSystemError,
  runFileSystemOperationWithRetry,
  runFileSystemOperationWithRetryAsync,
} from '../../src/adapters/filesystem/fileSystemRetry';
import { LruCache } from '../../src/services/support/lruCache';
import { describeVersionedFailure, parseVersioned } from '../../src/services/support/versioned';

const temporaryDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-team-test-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('LruCache', () => {
  it('rejects a capacity below one', () => {
    expect(() => new LruCache(0)).toThrow(/at least 1/);
    expect(() => new LruCache(1.5)).toThrow(/integer/);
  });

  it('evicts the least recently used entry, not the oldest inserted', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    // Reading 'a' makes 'b' the eviction candidate even though 'a' went in first.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
  });

  it('is the fix for the predecessor cache degenerating past its cap', () => {
    // FIFO eviction at the cap evicts the entry that is about to be read again.
    // Under LRU a repeatedly-read key survives an unbounded stream of new keys.
    const cache = new LruCache<string, number>(50);
    cache.set('hot', 1);
    for (let index = 0; index < 500; index++) {
      cache.set(`cold-${index}`, index);
      expect(cache.get('hot')).toBe(1);
    }

    expect(cache.size).toBe(50);
    expect(cache.get('hot')).toBe(1);
  });

  it('keeps size at the cap and reports order from oldest', () => {
    const cache = new LruCache<string, number>(3);
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, 1);

    expect(cache.size).toBe(3);
    expect(cache.keysFromOldest()).toEqual(['b', 'c', 'd']);
  });

  it('replaces a value without growing, and refreshes recency', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(99);

    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
  });

  it('supports miss, delete and clear', () => {
    const cache = new LruCache<string, number>(2);
    expect(cache.get('missing')).toBeUndefined();

    cache.set('a', 1);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);

    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('BoundedKeySet', () => {
  it('rejects a capacity below one', () => {
    expect(() => new BoundedKeySet(0)).toThrow(/at least 1/);
  });

  it('reports whether a key was newly added', () => {
    const seen = new BoundedKeySet<string>(4);
    expect(seen.add('a')).toBe(true);
    expect(seen.add('a')).toBe(false);
    expect(seen.size).toBe(1);
  });

  it('evicts the oldest key rather than growing without bound', () => {
    const seen = new BoundedKeySet<string>(3);
    for (const key of ['a', 'b', 'c', 'd']) seen.add(key);

    expect(seen.size).toBe(3);
    expect(seen.has('a')).toBe(false);
    expect(seen.has('d')).toBe(true);
  });

  it('stays bounded across a long event stream', () => {
    const seen = new BoundedKeySet<number>(100);
    for (let index = 0; index < 10_000; index++) seen.add(index);

    expect(seen.size).toBe(100);
  });

  it('supports delete and clear', () => {
    const seen = new BoundedKeySet<string>(2);
    seen.add('a');
    expect(seen.delete('a')).toBe(true);
    expect(seen.delete('a')).toBe(false);

    seen.add('b');
    seen.clear();
    expect(seen.size).toBe(0);
  });
});

describe('parseVersioned', () => {
  it('accepts a supported version', () => {
    const result = parseVersioned<{ version: number; id: string }>({ version: 1, id: 'a' }, [1]);
    expect(result).toEqual({ ok: true, value: { version: 1, id: 'a' } });
  });

  it.each([
    ['a non-object', 'nope', 'not-an-object'],
    ['null', null, 'not-an-object'],
    ['an array', [], 'not-an-object'],
    ['a missing version', { id: 'a' }, 'missing-version'],
    ['a non-integer version', { version: 1.5 }, 'missing-version'],
    ['a string version', { version: '1' }, 'missing-version'],
  ])('rejects %s', (_label, value, reason) => {
    const result = parseVersioned(value, [1]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe(reason);
  });

  it('reports the version it found when unsupported', () => {
    const result = parseVersioned({ version: 9 }, [1, 2]);
    expect(result).toEqual({ ok: false, failure: { reason: 'unsupported-version', found: 9 } });
  });

  it('accepts any of several supported versions', () => {
    expect(parseVersioned({ version: 2 }, [1, 2]).ok).toBe(true);
  });

  it('describes each failure for logs', () => {
    expect(describeVersionedFailure({ reason: 'not-an-object' }, 'status.json')).toMatch(/not an object/);
    expect(describeVersionedFailure({ reason: 'missing-version' }, 'status.json')).toMatch(/no integer version/);
    expect(describeVersionedFailure({ reason: 'unsupported-version', found: 4 }, 'status.json')).toMatch(
      /unsupported version 4/,
    );
  });
});

describe('file system retry', () => {
  it('classifies only contention codes as retryable', () => {
    for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
      expect(isRetryableFileSystemError(errorWithCode(code))).toBe(true);
    }
    for (const code of ['ENOENT', 'ENOTDIR', 'EISDIR']) {
      expect(isRetryableFileSystemError(errorWithCode(code))).toBe(false);
    }
    expect(isRetryableFileSystemError(new Error('no code'))).toBe(false);
    expect(isRetryableFileSystemError(undefined)).toBe(false);
  });

  it('retries a contended operation until it succeeds', () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = runFileSystemOperationWithRetry(
      () => {
        attempts++;
        if (attempts < 3) throw errorWithCode('EBUSY');
        return 'done';
      },
      { retryDelaysMs: [1, 2, 3], wait: (delayMs) => waits.push(delayMs) },
    );

    expect(result).toBe('done');
    expect(waits).toEqual([1, 2]);
  });

  it('rethrows immediately for a non-retryable code', () => {
    let attempts = 0;
    expect(() =>
      runFileSystemOperationWithRetry(
        () => {
          attempts++;
          throw errorWithCode('ENOENT');
        },
        { retryDelaysMs: [1, 2], wait: () => undefined },
      ),
    ).toThrow(/ENOENT/);
    expect(attempts).toBe(1);
  });

  it('gives up once the delay list is exhausted', () => {
    let attempts = 0;
    expect(() =>
      runFileSystemOperationWithRetry(
        () => {
          attempts++;
          throw errorWithCode('EPERM');
        },
        { retryDelaysMs: [1, 2], wait: () => undefined },
      ),
    ).toThrow(/EPERM/);
    expect(attempts).toBe(3);
  });

  it('retries asynchronously without blocking', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const result = await runFileSystemOperationWithRetryAsync(
      () => {
        attempts++;
        if (attempts < 2) throw errorWithCode('EACCES');
        return Promise.resolve('async-done');
      },
      { retryDelaysMs: [1], wait: async (delayMs) => void waits.push(delayMs) },
    );

    expect(result).toBe('async-done');
    expect(waits).toEqual([1]);
  });

  it('propagates a non-retryable async failure', async () => {
    await expect(
      runFileSystemOperationWithRetryAsync(
        () => {
          throw errorWithCode('ENOENT');
        },
        { retryDelaysMs: [1], wait: async () => undefined },
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it('resolves immediately for a non-positive delay', async () => {
    await expect(delayForFileSystemRetry(0)).resolves.toBeUndefined();
  });

  it('schedules a real timer for a positive delay', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = delayForFileSystemRetry(50).then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes a backoff that grows', () => {
    const delays = [...DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS];
    expect(delays[0]).toBe(10);
    for (let index = 1; index < delays.length; index++) {
      expect(delays[index]!).toBeGreaterThan(delays[index - 1]!);
    }
  });
});

describe('atomic json writer', () => {
  it('publishes a complete file and leaves no temp file behind', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'nested', 'status.json');

    writeAtomicJson(target, { state: 'running' });

    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ state: 'running' });
    expect(fs.readdirSync(path.dirname(target))).toEqual(['status.json']);
  });

  it('replaces an existing file in place', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'status.json');

    writeAtomicJson(target, { state: 'running' });
    writeAtomicJson(target, { state: 'complete' });

    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ state: 'complete' });
    expect(fs.readdirSync(dir)).toEqual(['status.json']);
  });

  it('publishes promise-based writes with an explicit private mode', async () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'nested', 'status.json');

    await writeAtomicJsonAsync(target, { state: 'running' }, 0o600);

    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ state: 'running' });
    expect(fs.readdirSync(path.dirname(target))).toEqual(['status.json']);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it('creates private files 0600 so a shared temp dir does not leak prompts', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'config.json');

    writePrivateAtomicJson(target, { systemPrompt: 'secret' });

    // Windows does not model POSIX permission bits.
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ systemPrompt: 'secret' });
  });

  it('names temp files distinctly per process and attempt', () => {
    const observed: string[] = [];
    const write = createAtomicJsonWriter({
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: ((filePath: string) => void observed.push(String(filePath))) as never,
        renameSync: () => undefined,
        rmSync: () => undefined,
      },
      pid: 4242,
      now: () => 1700000000000,
      random: () => 0.5,
    });

    write('/tmp/run/status.json', { a: 1 });

    expect(observed).toHaveLength(1);
    expect(path.basename(observed[0]!)).toMatch(/^\.status\.json\.4242\.1700000000000\..*\.tmp$/);
  });

  it('removes the temp file when the rename fails', () => {
    const removed: string[] = [];
    const write = createAtomicJsonWriter({
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        renameSync: () => {
          throw errorWithCode('ENOENT');
        },
        rmSync: ((filePath: string) => void removed.push(String(filePath))) as never,
      },
    });

    expect(() => write('/tmp/run/status.json', { a: 1 })).toThrow(/ENOENT/);
    expect(removed).toHaveLength(1);
    expect(path.basename(removed[0]!)).toMatch(/\.tmp$/);
  });

  it('retries a contended rename when retries are enabled', () => {
    let renameAttempts = 0;
    const waits: number[] = [];
    const write = createAtomicJsonWriter({
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        renameSync: () => {
          renameAttempts++;
          if (renameAttempts < 3) throw errorWithCode('EPERM');
        },
        rmSync: () => undefined,
      },
      retryRenameErrors: true,
      retryDelaysMs: [1, 2, 3],
      wait: (delayMs) => waits.push(delayMs),
    });

    write('/tmp/run/status.json', { a: 1 });

    expect(renameAttempts).toBe(3);
    expect(waits).toEqual([1, 2]);
  });

  it('does not retry a contended rename when retries are disabled', () => {
    let renameAttempts = 0;
    const write = createAtomicJsonWriter({
      fs: {
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
        renameSync: () => {
          renameAttempts++;
          throw errorWithCode('EPERM');
        },
        rmSync: () => undefined,
      },
      retryRenameErrors: false,
      wait: () => undefined,
    });

    expect(() => write('/tmp/run/status.json', { a: 1 })).toThrow(/EPERM/);
    expect(renameAttempts).toBe(1);
  });

  it('writes indented JSON so a run directory stays readable by hand', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'status.json');

    writeAtomicJson(target, { nested: { value: 1 } });

    expect(fs.readFileSync(target, 'utf-8')).toContain('\n  "nested"');
  });
});
