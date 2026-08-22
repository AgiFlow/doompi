import fs from 'node:fs/promises';
import type { FileEditEntry, TimelineEvent } from '../../types/domain';
import type { ITimelineStore } from '../../types/timelineStore';

const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 100;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TimelineEvent>;
  return (
    event.version === 1 &&
    typeof event.path === 'string' &&
    typeof event.at === 'number' &&
    (event.tool === 'edit' || event.tool === 'write' || event.tool === 'bash')
  );
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
    let content: string;
    try {
      content = await fs.readFile(this.requirePath(), 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const folded = new Map<string, FileEditEntry>();
    for (const line of content.split('\n')) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        console.warn(
          `Ignoring malformed file edit timeline line: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!isTimelineEvent(parsed)) continue;
      const current = folded.get(parsed.path);
      folded.set(parsed.path, {
        path: parsed.path,
        tool: parsed.at >= (current?.at ?? 0) ? parsed.tool : (current?.tool ?? parsed.tool),
        at: Math.max(parsed.at, current?.at ?? 0),
        count: (current?.count ?? 0) + 1,
      });
    }
    return [...folded.values()].sort((left, right) => right.at - left.at);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.requirePath());
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
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
