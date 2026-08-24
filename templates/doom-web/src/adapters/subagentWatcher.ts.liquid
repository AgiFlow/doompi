import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSubagentRun, presentRuns, RUN_STATUS_FILE_NAME, teamRunsDirFor } from '../services/subagentRuns.ts';
import type { SubagentRun } from '../types/hub.ts';

const POLL_MS = 1000;
const DEBOUNCE_MS = 60;

export interface SubagentRunsSource {
  close(): void;
}

/**
 * Watches doom-team's per-session runs directory for one session.
 *
 * Same reliability posture as the registry watcher: the poll is the source of
 * truth, fs.watch is only an accelerator, and the directory not existing yet
 * (no run ever started) is a normal state, not an error. Emits the presented
 * run list whenever it changes, including the transition to empty.
 */
export function watchSubagentRuns(sessionId: string, onRuns: (runs: SubagentRun[]) => void): SubagentRunsSource {
  const runsDir = teamRunsDirFor({ sessionId, tmpdir: os.tmpdir(), uid: process.getuid?.() });
  if (runsDir === undefined) return { close: () => undefined };

  let watcher: fs.FSWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  // Seeded with the empty fingerprint: a session with no runs yet should not
  // announce an empty fleet, only a fleet that changed.
  let lastEmitted: string | undefined = '[]';
  let closed = false;

  const scan = (): SubagentRun[] => {
    let names: string[];
    try {
      names = fs.readdirSync(runsDir);
    } catch {
      return []; // The directory appears with the first run.
    }
    const runs: SubagentRun[] = [];
    for (const name of names) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(runsDir, name, RUN_STATUS_FILE_NAME), 'utf8');
      } catch {
        continue; // Not a run dir, or the status is mid-write; the next pass settles it.
      }
      const run = parseSubagentRun(raw);
      if (run) runs.push(run);
    }
    return presentRuns(runs, Date.now());
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
      watcher = fs.watch(runsDir, { recursive: true }, () => {
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
