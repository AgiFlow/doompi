/**
 * Atomic JSON writes.
 *
 * DESIGN PATTERNS:
 * - Write to a uniquely named temp file in the destination directory, then
 *   rename onto the target. Rename is atomic within a filesystem, so a reader
 *   sees either the previous file or the complete new one, never a partial write
 * - The temp name carries pid, timestamp and a random suffix so two processes
 *   writing the same target never collide on the temp file
 *
 * WHAT THIS DOES NOT DO:
 * This prevents torn reads. It does NOT prevent lost updates: two writers doing
 * read-modify-write still clobber each other, because the rename only publishes
 * whatever the caller already computed. Anything needing mutual exclusion has to
 * take a lease or claim, not rely on atomic writes.
 *
 * AVOID:
 * - Treating this as a lock
 * - Using the plain writer for anything sensitive; prefer writePrivateAtomicJson,
 *   which creates the file 0600 so a shared temp directory does not leak prompts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
  runFileSystemOperationWithRetry,
  runFileSystemOperationWithRetryAsync,
  waitForFileSystemRetry,
} from './filesystem/fileSystemRetry';

const PRIVATE_FILE_MODE = 0o600;
const JSON_INDENT = 2;

type AtomicJsonFs = Pick<typeof fs, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>;

type AtomicJsonWriterOptions = {
  fs?: AtomicJsonFs;
  now?: () => number;
  pid?: number;
  random?: () => number;
  mode?: number;
  retryRenameErrors?: boolean;
  retryDirectoryErrors?: boolean;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => void;
};

export function createAtomicJsonWriter(
  options: AtomicJsonWriterOptions = {},
): (filePath: string, payload: object) => void {
  const fsImpl = options.fs ?? fs;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const random = options.random ?? Math.random;
  const mode = options.mode;
  // Retries exist for Windows directory and rename locks; other platforms fail fast.
  const retryRenameErrors = options.retryRenameErrors ?? process.platform === 'win32';
  const retryDirectoryErrors = options.retryDirectoryErrors ?? retryRenameErrors;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
  const renameRetryDelaysMs = retryRenameErrors ? retryDelaysMs : [];
  const directoryRetryDelaysMs = retryDirectoryErrors ? retryDelaysMs : [];
  const wait = options.wait ?? waitForFileSystemRetry;

  return (filePath: string, payload: object): void => {
    runFileSystemOperationWithRetry(
      () => {
        fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      },
      { retryDelaysMs: directoryRetryDelaysMs, wait },
    );
    const tempPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${pid}.${now()}.${random().toString(36).slice(2)}.tmp`,
    );
    try {
      fsImpl.writeFileSync(
        tempPath,
        JSON.stringify(payload, null, JSON_INDENT),
        mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode },
      );
      runFileSystemOperationWithRetry(
        () => {
          fsImpl.renameSync(tempPath, filePath);
        },
        { retryDelaysMs: renameRetryDelaysMs, wait },
      );
    } finally {
      // Best effort: on the happy path the rename already consumed the temp file.
      fsImpl.rmSync(tempPath, { force: true });
    }
  };
}

export const writeAtomicJson = createAtomicJsonWriter();
export const writePrivateAtomicJson = createAtomicJsonWriter({ mode: PRIVATE_FILE_MODE });

/** Promise-based atomic writer for startup, polling, and other non-critical paths. */
export async function writeAtomicJsonAsync(filePath: string, payload: object, mode?: number): Promise<void> {
  const retryDelaysMs = process.platform === 'win32' ? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS : [];
  await runFileSystemOperationWithRetryAsync(() => fs.promises.mkdir(path.dirname(filePath), { recursive: true }), {
    retryDelaysMs,
  });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(payload, null, JSON_INDENT),
      mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode },
    );
    await runFileSystemOperationWithRetryAsync(() => fs.promises.rename(tempPath, filePath), { retryDelaysMs });
  } finally {
    await fs.promises.rm(tempPath, { force: true });
  }
}
