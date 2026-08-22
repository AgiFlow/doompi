/**
 * Runs stopped by a session shutdown, and enough about each to start it again.
 *
 * WHY EVERY SHUTDOWN SUSPENDS, WITH NO SPECIAL CASE FOR `reload`:
 * Pi emits `session_shutdown` for `quit`, `reload`, `new`, `resume` and `fork`.
 * An earlier design kept children alive across `reload` alone, on the grounds
 * that `/domains`, `/major-mode` and `/profile` reload the extension rather than
 * change the session. That is true, and it still makes `reload` the one case
 * behaving differently from the other four - which is a rule someone has to
 * remember, and a branch that silently does the wrong thing if Pi ever adds a
 * sixth reason. Suspending uniformly costs a respawn on reload and removes the
 * special case; restore is cheap because the child continues its own transcript
 * rather than starting over.
 *
 * WHY RESTORE IS OFFERED AND NEVER AUTOMATIC:
 * Reopening a session would otherwise spawn N processes and start spending
 * tokens on tasks that may be days stale. `session_start` reports what is
 * suspended; something explicit has to ask for it back.
 *
 * AVOID:
 * - Auto-restoring from any lifecycle event
 * - Recording a suspended run without its `sessionFile`; without it a restore
 *   restarts the work instead of continuing it
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InlineAgent } from '@agimon-ai/doompi-extension-contracts/subagent-tool';

import { type SessionScope, scopeSuspendedDir } from './filesystem/paths';
import { parseVersioned } from '../services/support/versioned';
import { writeAtomicJson, writeAtomicJsonAsync } from './atomicJson';

const SUSPENDED_RUN_VERSION = 1;
const JSON_SUFFIX = '.json';

export interface SuspendedRun {
  version: typeof SUSPENDED_RUN_VERSION;
  runId: string;
  agent: string;
  runtime: string;
  task: string;
  cwd: string;
  model?: string;
  /** One-shot agent definition required to reconstruct an inline agent. */
  inlineAgent?: InlineAgent;
  context?: 'fresh' | 'fork';
  /** Last state the run reported before it was stopped. */
  lastStatus?: string;
  /**
   * The child's own transcript.
   *
   * This is what makes a restore a continuation: `sdkRunnerEntry.ts` opens it
   * through `SessionManager.open` when `sdk.sessionFile` is set. Absent for a
   * run that never persisted one (an external CLI, or a headless child), in
   * which case the record remains visible but cannot be restored.
   */
  sessionFile?: string;
  suspendedAt: number;
  /** Why the session went away, for the report a later `session_start` shows. */
  reason: string;
}

function suspendedPath(scope: SessionScope, runId: string): string {
  return path.join(scopeSuspendedDir(scope), `${runId}${JSON_SUFFIX}`);
}

export function suspendRun(scope: SessionScope, record: Omit<SuspendedRun, 'version'>): void {
  writeAtomicJson(suspendedPath(scope, record.runId), { version: SUSPENDED_RUN_VERSION, ...record });
}

export async function suspendRunAsync(scope: SessionScope, record: Omit<SuspendedRun, 'version'>): Promise<void> {
  await writeAtomicJsonAsync(suspendedPath(scope, record.runId), { version: SUSPENDED_RUN_VERSION, ...record });
}

function parseSuspendedRun(raw: string): SuspendedRun | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = parseVersioned<SuspendedRun>(parsed, [SUSPENDED_RUN_VERSION]);
  return result.ok && typeof result.value.runId === 'string' ? result.value : undefined;
}

export function listSuspendedRuns(scope: SessionScope): SuspendedRun[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(scopeSuspendedDir(scope));
  } catch {
    return [];
  }

  const runs: SuspendedRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(JSON_SUFFIX)) continue;
    let run: SuspendedRun | undefined;
    try {
      run = parseSuspendedRun(fs.readFileSync(path.join(scopeSuspendedDir(scope), entry), 'utf-8'));
    } catch {
      // A record this build cannot read is skipped, not deleted: it may belong
      // to a newer build that will read it back correctly.
      continue;
    }
    if (run) runs.push(run);
  }
  return runs.sort((left, right) => left.suspendedAt - right.suspendedAt);
}

export async function listSuspendedRunsAsync(scope: SessionScope): Promise<SuspendedRun[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(scopeSuspendedDir(scope));
  } catch {
    return [];
  }

  const runs: SuspendedRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(JSON_SUFFIX)) continue;
    try {
      const run = parseSuspendedRun(await fs.promises.readFile(path.join(scopeSuspendedDir(scope), entry), 'utf-8'));
      if (run) runs.push(run);
    } catch {
      // A record this build cannot read is skipped, not deleted.
    }
  }
  return runs.sort((left, right) => left.suspendedAt - right.suspendedAt);
}

/** Drop a record once its run has been restored, or explicitly discarded. */
export function clearSuspendedRun(scope: SessionScope, runId: string): void {
  try {
    fs.rmSync(suspendedPath(scope, runId), { force: true });
  } catch {
    // Best effort: a leftover record shows up again in the next report, which
    // is a visible annoyance rather than a lost run.
  }
}

/** Whether an explicit restore can safely continue this exact run. */
export function isSuspendedRunResumable(run: SuspendedRun): boolean {
  if (run.runtime !== 'pi' || !run.agent.trim() || !run.task.trim() || !run.cwd.trim() || !run.sessionFile) {
    return false;
  }
  try {
    fs.accessSync(run.sessionFile, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isSuspendedRunResumableAsync(run: SuspendedRun): Promise<boolean> {
  if (run.runtime !== 'pi' || !run.agent.trim() || !run.task.trim() || !run.cwd.trim() || !run.sessionFile) {
    return false;
  }
  try {
    await fs.promises.access(run.sessionFile, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** One line per suspended run, for the report `session_start` prints. */
export function formatSuspendedRuns(runs: SuspendedRun[]): string {
  if (runs.length === 0) return '';
  const lines = runs.map((run) => {
    const continues = isSuspendedRunResumable(run) ? 'resumable' : 'not resumable';
    return `- ${run.runId} (${run.agent}, ${run.runtime}, ${continues}): ${run.task.split('\n')[0]}`;
  });
  const noun = runs.length === 1 ? 'subagent' : 'subagents';
  return [
    `${runs.length} suspended ${noun} from this session:`,
    ...lines,
    '',
    'They are stopped. Restore one with subagent {"action":"restore","id":"<run-id>"}, or leave them.',
  ].join('\n');
}

export async function formatSuspendedRunsAsync(runs: SuspendedRun[]): Promise<string> {
  if (runs.length === 0) return '';
  const resumable = await Promise.all(runs.map((run) => isSuspendedRunResumableAsync(run)));
  const lines = runs.map((run, index) => {
    const continues = resumable[index] ? 'resumable' : 'not resumable';
    return `- ${run.runId} (${run.agent}, ${run.runtime}, ${continues}): ${run.task.split('\n')[0]}`;
  });
  const noun = runs.length === 1 ? 'subagent' : 'subagents';
  return [
    `${runs.length} suspended ${noun} from this session:`,
    ...lines,
    '',
    'They are stopped. Restore one with subagent {"action":"restore","id":"<run-id>"}, or leave them.',
  ].join('\n');
}
