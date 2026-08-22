import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Private atomic JSON writes.
 *
 * Write to a uniquely named temporary file in the destination directory, then
 * rename onto the target. Rename is atomic within a filesystem, so a reader
 * sees either the previous file or the complete new one and never a partial
 * write. The temporary name carries the pid and a random suffix, so two
 * processes writing the same target cannot collide on it.
 *
 * This prevents torn reads. It does NOT prevent lost updates: two writers doing
 * read-modify-write still clobber each other, because the rename only publishes
 * what the caller already computed. Harness state avoids that by giving every
 * process a file it owns rather than by locking.
 *
 * AVOID:
 * - Treating this as a lock
 * - Leaving the temporary file behind when the write fails
 */

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const TEMPORARY_SUFFIX = '.tmp';

/** Writes JSON readable by its owner only, replacing the target atomically. */
export function writePrivateAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}${TEMPORARY_SUFFIX}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
