import type { RunnerBackend, RunnerExitReason, RunnerState } from './runnerRegistry.ts';

/**
 * Runner run view types shared by this package's hub channel and its web
 * plugin. The shape is the per-runner metadata record this package's own
 * registry writes, minus node-only types, so the cockpit bundle can carry it;
 * the cockpit renders them as 'runner_runs' channel payloads.
 */

export interface RunnerRunExitView {
  reason: RunnerExitReason;
  code: number | null;
  /** The signal name, when the process was signaled. */
  signal: string | null;
  stopReason?: string;
  /** ISO 8601, from the record. */
  finishedAt: string;
}

/** One runner of a session: a supervised command, retained after it exits. */
export interface RunnerRunView {
  id: string;
  name: string;
  pid: number;
  command: string;
  cwd: string;
  interactive: boolean;
  backend: RunnerBackend;
  state: RunnerState;
  /** True once the run outlived its bash call and became a background runner. */
  promoted: boolean;
  /** ISO 8601, from the record. */
  startedAt: string;
  exit?: RunnerRunExitView;
}

export const RUNNER_RUNS_TYPE = 'runner_runs';
