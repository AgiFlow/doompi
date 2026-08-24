import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  completeWorkflowRunView,
  foldWorkflowProgress,
  type ParsedWorkflowRun,
  parseWorkflowProgress,
  parseWorkflowRunRecord,
  PROGRESS_FILE_NAME,
  resolveWorkflowHome,
  RUN_RECORD_FILE_NAME,
  WORKFLOW_HOME_ENV,
  WORKFLOW_STAGES,
  WORKSPACES_DIR_NAME,
} from '../services/workflowRuns.ts';
import type { WorkflowJobView } from '../types/hub.ts';

const POLL_MS = 2000;
const DEBOUNCE_MS = 80;

export interface WorkflowRunsSource {
  close(): void;
}

export interface WatchWorkflowRunsOptions {
  /** Registry home override, the test seam; defaults to the engine's own resolution. */
  homeDir?: string;
}

interface CachedParse<T> {
  size: number;
  mtimeMs: number;
  value: T;
}

/**
 * Watches workflow-mcp's registry, one watcher for the whole hub: the
 * registry is global, per-session scoping happens where the summaries live.
 *
 * Same reliability posture as the other watchers: the poll is the source of
 * truth, fs.watch is only an accelerator, and a missing registry home (no
 * workflow ever ran) is a normal state. Files are re-parsed only when their
 * size or mtime moved, because a scan touches every run the registry holds.
 * Emits the parsed run set whenever it changes, including the transition to
 * empty.
 */
export function watchWorkflowRuns(
  onRuns: (runs: ParsedWorkflowRun[]) => void,
  options: WatchWorkflowRunsOptions = {},
): WorkflowRunsSource {
  const homeDir =
    options.homeDir ?? resolveWorkflowHome({ envValue: process.env[WORKFLOW_HOME_ENV], homeDir: os.homedir() });
  const workspacesDir = path.join(homeDir, WORKSPACES_DIR_NAME);

  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  // Seeded with the empty fingerprint: a machine with no runs should not
  // announce an empty registry, only a registry that changed.
  let lastEmitted: string | undefined = '[]';
  let closed = false;
  const recordCache = new Map<string, CachedParse<ParsedWorkflowRun | undefined>>();
  const progressCache = new Map<string, CachedParse<WorkflowJobView[]>>();

  function cachedParse<T>(
    cache: Map<string, CachedParse<T>>,
    filePath: string,
    parse: (raw: string) => T,
    empty: T,
  ): T {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      cache.delete(filePath);
      return empty; // Absent is a normal state: a run may have no progress yet.
    }
    const cached = cache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      cache.delete(filePath);
      return empty; // Mid-move or mid-write; the next pass settles it.
    }
    const value = parse(raw);
    cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  }

  const listDir = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort();
    } catch {
      return []; // The directory appears with the first run.
    }
  };

  const scan = (): ParsedWorkflowRun[] => {
    const runs: ParsedWorkflowRun[] = [];
    const seenPaths = new Set<string>();
    for (const workspace of listDir(workspacesDir)) {
      for (const stage of WORKFLOW_STAGES) {
        const stageDir = path.join(workspacesDir, workspace, stage);
        for (const runKey of listDir(stageDir)) {
          const runDir = path.join(stageDir, runKey);
          const recordPath = path.join(runDir, RUN_RECORD_FILE_NAME);
          const progressPath = path.join(runDir, PROGRESS_FILE_NAME);
          seenPaths.add(recordPath);
          seenPaths.add(progressPath);
          const parsed = cachedParse(recordCache, recordPath, parseWorkflowRunRecord, undefined);
          if (parsed === undefined) continue;
          const jobs = cachedParse(
            progressCache,
            progressPath,
            (raw) => foldWorkflowProgress(parseWorkflowProgress(raw)),
            [],
          );
          runs.push({ ...parsed, view: completeWorkflowRunView(parsed.view, jobs) });
        }
      }
    }
    for (const key of recordCache.keys()) if (!seenPaths.has(key)) recordCache.delete(key);
    for (const key of progressCache.keys()) if (!seenPaths.has(key)) progressCache.delete(key);
    return runs;
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
      watcher = fs.watch(workspacesDir, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(emit, DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined; // The poll re-establishes it once the dir is back.
      });
    } catch {
      // The registry does not exist yet; the poll keeps trying.
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
