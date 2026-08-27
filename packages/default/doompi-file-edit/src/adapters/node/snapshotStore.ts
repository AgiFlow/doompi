import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotStorePort } from '../../types/snapshotStore.ts';

/**
 * Store and read the file content this session's diffs are built from.
 *
 * One technology per adapter. This is where node enters the package; the
 * services that depend on the capability keep importing the port.
 *
 * Snapshots are content-addressed, so a file written twice with the same bytes
 * occupies one blob and the second capture is a hash and an exists check. The
 * whole directory goes when the session's timeline does, which is what keeps
 * this from growing without bound across a machine's lifetime.
 */

/** Past this, a file is listed as changed without content rather than snapshotted. */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/** How much of a file is read before deciding it is binary. */
const BINARY_SAMPLE_BYTES = 8192;

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG']);

function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.has(error.code);
}

export class NodeSnapshotStoreAdapter implements SnapshotStorePort {
  private directory: string | undefined;

  initialize(directory: string): void {
    this.directory = directory;
  }

  async capture(filePath: string): Promise<string | undefined> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(filePath);
    } catch (error) {
      if (hasCode(error, MISSING_CODES)) return undefined;
      throw error;
    }
    if (raw.byteLength > MAX_SNAPSHOT_BYTES) return undefined;
    if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) return undefined;
    return this.put(raw.toString('utf8'));
  }

  async put(content: string): Promise<string> {
    const hash = createHash('sha256').update(content, 'utf8').digest('hex');
    const blobPath = path.join(this.requireDirectory(), hash);
    // An existing blob already holds exactly this content, by construction, so
    // rewriting it would only cost a write.
    try {
      await fs.access(blobPath);
      return hash;
    } catch (error) {
      if (!hasCode(error, MISSING_CODES)) throw error;
    }
    await fs.mkdir(this.requireDirectory(), { recursive: true });
    await fs.writeFile(blobPath, content, 'utf8');
    return hash;
  }

  async read(hash: string): Promise<string | undefined> {
    if (!/^[0-9a-f]{64}$/u.test(hash)) return undefined;
    try {
      return await fs.readFile(path.join(this.requireDirectory(), hash), 'utf8');
    } catch (error) {
      if (hasCode(error, MISSING_CODES)) return undefined;
      throw error;
    }
  }

  async clear(): Promise<void> {
    if (this.directory === undefined) return;
    await fs.rm(this.directory, { recursive: true, force: true });
  }

  private requireDirectory(): string {
    if (this.directory === undefined) throw new Error('Snapshot store is not initialized');
    return this.directory;
  }
}
