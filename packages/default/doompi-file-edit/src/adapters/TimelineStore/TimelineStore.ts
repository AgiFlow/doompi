import fs from 'node:fs/promises';
import {
  type AnyTimelineEvent,
  confirmedChanges,
  foldEntries,
  foldVersions,
  parseTimeline,
} from '../../services/fileChanges.ts';
import type { FileEditEntry, FileEditVersion, TimelineEvent } from '../../types/domain';
import type { ITimelineStore } from '../../types/timelineStore';

const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 100;

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
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const lock = await fs.open(lockPath, 'wx');
        try {
          return await operation();
        } finally {
          await lock.close();
          try {
            await fs.unlink(lockPath);
          } catch (error) {
            if (!hasCode(error, 'ENOENT')) console.warn(`Could not remove timeline lock: ${String(error)}`);
          }
        }
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    throw new Error(`Timed out acquiring timeline lock ${lockPath}`);
  }
}
