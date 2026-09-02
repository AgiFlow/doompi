import fs, { type FileHandle } from 'node:fs/promises';
import {
  type AnyTimelineEvent,
  confirmedChanges,
  foldEntries,
  foldVersions,
  parseTimeline,
} from '../../services/fileChanges.ts';
import type { FileEditEntry, FileEditVersion, TimelineEvent } from '../../types/domain';
import type { ITimelineStore } from '../../types/timelineStore';

const LOCK_RETRY_MS = 25;
const LOCK_RETRIES = 400;
/**
 * How long a lock file may sit untouched before a waiter treats it as abandoned.
 *
 * An append writes one line, so a holder that has been there for half a minute
 * is a process that died without unlinking. Without this, that one file would
 * block every later append to the same timeline permanently.
 */
const LOCK_STALE_MS = 30_000;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class TimelineStore implements ITimelineStore {
  private filePath: string | undefined;

  initialize(filePath: string): void {
    this.filePath = filePath;
  }

  async append(event: TimelineEvent): Promise<void> {
    await this.withLock(async () => fs.appendFile(this.requirePath(), `${JSON.stringify(event)}\n`, 'utf8'));
  }

  async list(): Promise<FileEditEntry[]> {
    // Listing shows what was edited, so a path a command only touched is left out.
    return foldEntries(confirmedChanges(await this.events()));
  }

  async versions(filePath: string): Promise<FileEditVersion[]> {
    return foldVersions(await this.events(), filePath);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.requirePath());
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }

  /** Every recorded change, or none at all when the session has not written yet. */
  private async events(): Promise<AnyTimelineEvent[]> {
    let content: string;
    try {
      content = await fs.readFile(this.requirePath(), 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    return parseTimeline(content, (line) =>
      console.warn(`Ignoring malformed file edit timeline line: ${line.slice(0, 200)}`),
    );
  }

  private requirePath(): string {
    if (!this.filePath) throw new Error('Timeline store is not initialized');
    return this.filePath;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.requirePath()}.lock`;
    const lock = await this.acquire(lockPath);
    try {
      return await operation();
    } finally {
      await lock.close();
      await this.release(lockPath);
    }
  }

  /** Waits for the lock file, breaking one an earlier process left behind. */
  private async acquire(lockPath: string): Promise<FileHandle> {
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        return await fs.open(lockPath, 'wx');
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        if (await this.breakStale(lockPath)) continue;
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    throw new Error(`Timed out acquiring timeline lock ${lockPath}`);
  }

  /** Whether the lock is now free to take, having removed it when its holder is gone. */
  private async breakStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(lockPath);
      if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return false;
      await fs.unlink(lockPath);
      return true;
    } catch (error) {
      // Already gone, or another waiter broke it first: either way, try again.
      if (hasCode(error, 'ENOENT')) return true;
      throw error;
    }
  }

  private async release(lockPath: string): Promise<void> {
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) console.warn(`Could not remove timeline lock: ${String(error)}`);
    }
  }
}
