import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
  delayForFileSystemRetry,
  isRetryableFileSystemError,
  runFileSystemOperationWithRetry,
  runFileSystemOperationWithRetryAsync,
  waitForFileSystemRetry,
} from '../../src/adapters/filesystem/fileSystemRetry';

/** An error carrying an errno-style `code`, since that is all the retry logic reads. */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('isRetryableFileSystemError', () => {
  it.each(['EACCES', 'EBUSY', 'EPERM'])('treats %s as transient contention', (code) => {
    expect(isRetryableFileSystemError(errnoError(code))).toBe(true);
  });

  it('does not retry ENOENT or ENOTDIR, because those are real errors rather than contention', () => {
    expect(isRetryableFileSystemError(errnoError('ENOENT'))).toBe(false);
    expect(isRetryableFileSystemError(errnoError('ENOTDIR'))).toBe(false);
  });

  it('treats a value with no code as non-retryable', () => {
    expect(isRetryableFileSystemError(new Error('plain'))).toBe(false);
    expect(isRetryableFileSystemError('a string')).toBe(false);
    expect(isRetryableFileSystemError(undefined)).toBe(false);
  });
});

describe('runFileSystemOperationWithRetry (sync)', () => {
  it('returns the result on the first try without waiting at all', () => {
    const wait = vi.fn();
    const result = runFileSystemOperationWithRetry(() => 'ok', { wait });
    expect(result).toBe('ok');
    expect(wait).not.toHaveBeenCalled();
  });

  it('retries a transient error and returns once the operation stops throwing', () => {
    const wait = vi.fn();
    let attempts = 0;
    const result = runFileSystemOperationWithRetry(
      () => {
        attempts++;
        if (attempts < 3) throw errnoError('EBUSY');
        return 'recovered';
      },
      { wait, retryDelaysMs: [10, 20, 30] },
    );
    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
    // Backoff is consumed in order, one wait per failed attempt.
    expect(wait.mock.calls).toEqual([[10], [20]]);
  });

  it('rethrows immediately on a non-retryable error, without waiting at all', () => {
    const wait = vi.fn();
    const error = errnoError('ENOENT');
    expect(() =>
      runFileSystemOperationWithRetry(
        () => {
          throw error;
        },
        { wait },
      ),
    ).toThrow(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it('exhausts the retry delays and rethrows the last error, rather than retrying forever', () => {
    const wait = vi.fn();
    const error = errnoError('EACCES');
    expect(() =>
      runFileSystemOperationWithRetry(
        () => {
          throw error;
        },
        { wait, retryDelaysMs: [1, 2] },
      ),
    ).toThrow(error);
    // Two delays configured means two waits, then the third attempt's failure is fatal.
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('defaults to the exported delay table when none is supplied', () => {
    const wait = vi.fn();
    let attempts = 0;
    runFileSystemOperationWithRetry(
      () => {
        attempts++;
        if (attempts < 2) throw errnoError('EBUSY');
        return 'ok';
      },
      { wait },
    );
    expect(wait).toHaveBeenCalledWith(DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[0]);
  });
});

describe('runFileSystemOperationWithRetryAsync', () => {
  it('resolves on the first try without waiting', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(runFileSystemOperationWithRetryAsync(() => 'ok', { wait })).resolves.toBe('ok');
    expect(wait).not.toHaveBeenCalled();
  });

  it('awaits an async operation and retries it the same way as a sync one', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const result = await runFileSystemOperationWithRetryAsync(
      async () => {
        attempts++;
        if (attempts < 3) throw errnoError('EPERM');
        return 'recovered';
      },
      { wait, retryDelaysMs: [10, 20, 30] },
    );
    expect(result).toBe('recovered');
    expect(wait.mock.calls).toEqual([[10], [20]]);
  });

  it('rethrows a non-retryable error immediately, without waiting', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const error = errnoError('ENOTDIR');
    await expect(
      runFileSystemOperationWithRetryAsync(
        () => {
          throw error;
        },
        { wait },
      ),
    ).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  });

  it('exhausts the retry delays and rejects with the last error', async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    const error = errnoError('EBUSY');
    await expect(
      runFileSystemOperationWithRetryAsync(
        () => {
          throw error;
        },
        { wait, retryDelaysMs: [1] },
      ),
    ).rejects.toBe(error);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  describe('default wait, so a caller that supplies no override still does not busy-spin', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is driven by a real timer rather than a spin loop, because it only settles once fake time is advanced', async () => {
      let attempts = 0;
      const settled = vi.fn();
      const promise = runFileSystemOperationWithRetryAsync(
        () => {
          attempts++;
          if (attempts < 2) throw errnoError('EBUSY');
          return 'ok';
        },
        { retryDelaysMs: [5] },
      ).then(settled);

      // Flush pending microtasks without advancing time: a spin loop would have
      // already finished by now, but a timer-backed wait has not.
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5);
      await promise;
      expect(settled).toHaveBeenCalledWith('ok');
    });
  });

  it('delayForFileSystemRetry resolves without delay for a non-positive value', async () => {
    await expect(delayForFileSystemRetry(0)).resolves.toBeUndefined();
    await expect(delayForFileSystemRetry(-5)).resolves.toBeUndefined();
  });
});

describe('waitForFileSystemRetry (sync primitive)', () => {
  it('returns immediately for a non-positive delay, without blocking', () => {
    const start = Date.now();
    waitForFileSystemRetry(0);
    waitForFileSystemRetry(-10);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('blocks for approximately the requested delay', () => {
    const start = Date.now();
    waitForFileSystemRetry(30);
    // Generous bounds: this is a real wall-clock wait, not a mock.
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
