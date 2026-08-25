import fs from 'node:fs';
import path from 'node:path';
import { isRecordFileName, parseSessionRecord, sessionRecordsDir } from '../services/registryStore.ts';
import type { SessionRecord } from '../types/registry.ts';

const POLL_MS = 2000;
const DEBOUNCE_MS = 50;

/** Where the hub learns which sessions exist: a watcher in hub mode, a fixed record otherwise. */
export interface RecordSource {
  /** Calls back with the full current record set, immediately and on every change. */
  subscribe(listener: (records: SessionRecord[]) => void): void;
  close(): void;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else; only ESRCH
    // proves the server is gone.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Watches the registry directory for session records.
 *
 * The 2s poll is the source of truth; fs.watch merely accelerates it, because
 * on macOS watch events around atomic renames are best-effort. Records whose
 * pid is gone are stale by definition (a crashed server cannot withdraw its
 * own record) and are deleted here, the one janitor in the system.
 */
export function watchRegistry(registryDir: string, onNotice?: (message: string) => void): RecordSource {
  const recordsDir = sessionRecordsDir(registryDir);
  let listener: ((records: SessionRecord[]) => void) | undefined;
  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let closed = false;

  const scan = (): SessionRecord[] => {
    let names: string[];
    try {
      names = fs.readdirSync(recordsDir);
    } catch {
      // The directory appears with the first server; an empty registry is not
      // an error.
      return [];
    }
    const records: SessionRecord[] = [];
    for (const name of names.filter(isRecordFileName)) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(recordsDir, name), 'utf8');
      } catch {
        continue; // Withdrawn between readdir and read; the next scan settles it.
      }
      const record = parseSessionRecord(raw);
      if (!record) continue;
      if (!pidAlive(record.pid)) {
        fs.rmSync(path.join(recordsDir, name), { force: true });
        onNotice?.(`removed stale record for session ${record.id}`);
        continue;
      }
      records.push(record);
    }
    return records.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  };

  const emit = (): void => {
    if (!closed) listener?.(scan());
  };

  const ensureWatcher = (): void => {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(recordsDir, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(emit, DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined; // The poll re-establishes it once the dir is back.
      });
    } catch {
      // The directory does not exist yet; the poll keeps trying.
    }
  };

  return {
    subscribe(next) {
      listener = next;
      ensureWatcher();
      emit();
      poll = setInterval(() => {
        ensureWatcher();
        emit();
      }, POLL_MS);
    },
    close() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      if (poll) clearInterval(poll);
      watcher?.close();
      listener = undefined;
    },
  };
}

/** Wraps the fixed single-session CLI mode in the same source shape the hub consumes. */
export function staticRecordSource(record: SessionRecord): RecordSource {
  return {
    subscribe(listener) {
      listener([record]);
    },
    close() {
      // Nothing to release.
    },
  };
}
