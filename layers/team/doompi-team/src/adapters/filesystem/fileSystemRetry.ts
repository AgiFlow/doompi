/**
 * Retry helpers for transient filesystem failures.
 *
 * Windows holds brief directory and rename locks (antivirus, indexers, another
 * process reading the file), surfacing as EACCES, EBUSY or EPERM. Those clear on
 * their own, so the operation is retried on a backoff instead of failing a run.
 *
 * DESIGN PATTERNS:
 * - Two variants with the same policy: a synchronous one for the atomic writers
 *   that must not yield mid-write, and an async one for everything else
 *
 * AVOID:
 * - Reaching for the synchronous variant on a hot path; it blocks the event
 *   loop, and every millisecond of backoff is a millisecond the parent cannot
 *   service a child. Prefer `runFileSystemOperationWithRetryAsync`
 * - Retrying ENOENT or ENOTDIR; those are real errors, not contention
 */

const WAIT_BUFFER = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;
const RETRYABLE_FILE_SYSTEM_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

export type FileSystemRetryOptions = {
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => void;
};

export type AsyncFileSystemRetryOptions = {
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
};

/**
 * Block the current thread for `delayMs`.
 *
 * Only for synchronous callers that cannot yield. `Atomics.wait` parks the
 * thread rather than burning CPU; the loop below is a portable fallback for
 * runtimes without SharedArrayBuffer and does spin, which is why async callers
 * must use `delayForFileSystemRetry` instead.
 */
export function waitForFileSystemRetry(delayMs: number): void {
  if (delayMs <= 0) return;
  if (WAIT_VIEW) {
    try {
      Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
      return;
    } catch {
      // Fall through to the portable busy wait below.
    }
  }
  const end = Date.now() + delayMs;
  while (Date.now() < end) {
    // Portable fallback for runtimes where Atomics.wait is unavailable.
  }
}

/** Yield for `delayMs` without blocking the event loop. */
export function delayForFileSystemRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function isRetryableFileSystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RETRYABLE_FILE_SYSTEM_ERROR_CODES.has(code);
}

export function runFileSystemOperationWithRetry<T>(operation: () => T, options: FileSystemRetryOptions = {}): T {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitForFileSystemRetry;
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableFileSystemError(error)) throw error;
      wait(delayMs);
    }
  }
}

export async function runFileSystemOperationWithRetryAsync<T>(
  operation: () => T | Promise<T>,
  options: AsyncFileSystemRetryOptions = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
  const wait = options.wait ?? delayForFileSystemRetry;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableFileSystemError(error)) throw error;
      await wait(delayMs);
    }
  }
}
