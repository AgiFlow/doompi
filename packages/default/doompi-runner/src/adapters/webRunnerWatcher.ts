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

export interface WatchRunnerRunsOptions {
  /** The store root; defaults to this environment's agent directory. */
  storeDir?: string;
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
 */
export function watchRunnerRuns(
  sessionId: string,
  onRuns: (runs: RunnerRunView[]) => void,
  options: WatchRunnerRunsOptions = {},
): RunnerRunsSource {
  const stateDir = runnerStateDirFor(options.storeDir ?? resolveRunnerStoreDirectory(process.env), sessionId);

  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  // Seeded with the empty fingerprint: a session with no runners yet should
  // not announce an empty list, only a list that changed.
  let lastEmitted: string | undefined = '[]';
  let closed = false;

  const scan = (): RunnerRunView[] => {
    let names: string[];
    try {
      names = fs.readdirSync(stateDir);
    } catch {
      return []; // The directory appears with the first runner.
    }
    const records: RunnerRecord[] = [];
    for (const name of names) {
      if (!isPrimaryMetadataEntry(name)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(stateDir, name), 'utf8');
      } catch {
        continue; // Renamed away between the listing and the read; the next pass settles it.
      }
      const record = parseRunnerRecord(raw);
      if (record) records.push(record);
    }
    return presentRunnerRuns(records, Date.now());
  };

  const emit = (): void => {
    if (closed) return;
    const runs = scan();
    const fingerprint = JSON.stringify(runs);
    if (fingerprint === lastEmitted) return;
    lastEmitted = fingerprint;
    onRuns(runs);
  };

  const ensureWatcher = (): void => {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(stateDir, () => {
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

  ensureWatcher();
  emit();
  const poll = setInterval(() => {
    ensureWatcher();
    emit();
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
