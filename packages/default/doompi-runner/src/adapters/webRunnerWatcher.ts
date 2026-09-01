import fs from 'node:fs';
import path from 'node:path';
import { parseRunnerRecord, presentRunnerRuns } from '../services/webRunnerRuns.ts';
import type { RunnerRecord } from '../types/runnerRegistry';
import type { RunnerRunView } from '../types/webRunners.ts';
import { resolveRunnerStoreDirectory } from './RunnerPaths.ts';

const POLL_MS = 1000;
const DEBOUNCE_MS = 60;
const STATE_DIR_NAME = 'runs';
const STATE_EXTENSION = '.json';
const SIDECAR_SUFFIXES = ['.command.json', '.exit.json'];

export interface RunnerRunsSource {
  close(): void;
}

/** The filesystem calls the watcher makes, so a test can count them. */
export interface RunnerWatcherFs {
  readdir(directory: string): Promise<string[]>;
  stat(target: string): Promise<{ mtimeMs: number; size: number }>;
  readFile(target: string): Promise<string>;
}

const nodeWatcherFs: RunnerWatcherFs = {
  readdir: (directory) => fs.promises.readdir(directory),
  stat: async (target) => {
    const stats = await fs.promises.stat(target);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  },
  readFile: (target) => fs.promises.readFile(target, 'utf8'),
};

/** One metadata file as last parsed, keyed by the stat that produced it. */
interface CachedRecord {
  readonly mtimeMs: number;
  readonly size: number;
  readonly record: RunnerRecord | undefined;
}

export interface WatchRunnerRunsOptions {
  /** The store root; defaults to this environment's agent directory. */
  storeDir?: string;
  /** Filesystem port; defaults to the real one. */
  fsPort?: RunnerWatcherFs;
}

/** The state directory the registry writes a session's records into. */
export function runnerStateDirFor(storeDir: string, sessionId: string): string {
  return path.join(storeDir, sessionId, STATE_DIR_NAME);
}

function isPrimaryMetadataEntry(entry: string): boolean {
  return entry.endsWith(STATE_EXTENSION) && !SIDECAR_SUFFIXES.some((suffix) => entry.endsWith(suffix));
}

/**
 * Watches one session's runner state directory from outside the owning
 * process.
 *
 * Same reliability posture as the other hub watchers: the poll is the source
 * of truth, fs.watch only accelerates it, and the directory not existing yet
 * (no runner ever started) is a normal state. Emits the presented run list
 * whenever it changes, which includes finished runs ageing out of retention.
 *
 * A session accumulates completed runners, so re-reading and re-parsing every
 * metadata file once a second would cost more the longer the session lived,
 * on the hub's own event loop. Parsed records are therefore cached against the
 * mtime and size that produced them, and the scan is asynchronous: a steady
 * tick reads only the files that actually changed, and never blocks the hub.
 */
export function watchRunnerRuns(
  sessionId: string,
  onRuns: (runs: RunnerRunView[]) => void,
  options: WatchRunnerRunsOptions = {},
): RunnerRunsSource {
  const stateDir = runnerStateDirFor(options.storeDir ?? resolveRunnerStoreDirectory(process.env), sessionId);
  const port = options.fsPort ?? nodeWatcherFs;
  const cache = new Map<string, CachedRecord>();

  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  // Seeded with the empty fingerprint: a session with no runners yet should
  // not announce an empty list, only a list that changed.
  let lastEmitted: string | undefined = '[]';
  let closed = false;
  let scanning = false;

  const scan = async (): Promise<RunnerRunView[]> => {
    let names: string[];
    try {
      names = await port.readdir(stateDir);
    } catch {
      cache.clear();
      return []; // The directory appears with the first runner.
    }
    const records: RunnerRecord[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      if (!isPrimaryMetadataEntry(name)) continue;
      const target = path.join(stateDir, name);
      seen.add(target);
      let stats: { mtimeMs: number; size: number };
      try {
        stats = await port.stat(target);
      } catch {
        continue; // Renamed away between the listing and the stat; the next pass settles it.
      }
      const cached = cache.get(target);
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        if (cached.record) records.push(cached.record);
        continue;
      }
      let raw: string;
      try {
        raw = await port.readFile(target);
      } catch {
        continue; // Renamed away between the listing and the read; the next pass settles it.
      }
      const record = parseRunnerRecord(raw);
      cache.set(target, { mtimeMs: stats.mtimeMs, size: stats.size, record });
      if (record) records.push(record);
    }
    // Records the registry swept are gone for good; their cache entries follow.
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    return presentRunnerRuns(records, Date.now());
  };

  const emit = async (): Promise<void> => {
    // Overlapping scans would only race each other to the same answer.
    if (closed || scanning) return;
    scanning = true;
    try {
      const runs = await scan();
      if (closed) return;
      const fingerprint = JSON.stringify(runs);
      if (fingerprint === lastEmitted) return;
      lastEmitted = fingerprint;
      onRuns(runs);
    } finally {
      scanning = false;
    }
  };

  const ensureWatcher = (): void => {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(stateDir, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void emit(), DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined; // The poll re-establishes it once the dir is back.
      });
    } catch {
      // The directory does not exist yet; the poll keeps trying.
    }
  };

  ensureWatcher();
  void emit();
  const poll = setInterval(() => {
    ensureWatcher();
    void emit();
  }, POLL_MS);

  return {
    close() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
