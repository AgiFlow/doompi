/**
 * Subagent run view types shared by this package's hub channel and its web
 * plugin. The shapes mirror the per-run status files this package's own
 * runtime writes; the cockpit renders them as 'subagent_runs' channel
 * payloads.
 */

/** Coarse run state the cockpit renders; rawState keeps doom-team's exact word. */
export type SubagentRunState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

/**
 * One subagent run of a session, read from doom-team's per-run status file.
 */
export interface SubagentRun {
  runId: string;
  agent: string;
  state: SubagentRunState;
  rawState: string;
  /** The delegation prompt the main agent gave this run. */
  task: string;
  /** A doom-task binding, when the delegation named one; wins over task in the card. */
  taskRef?: string;
  model?: string;
  cwd: string;
  /** Epoch milliseconds, as doom-team writes them. */
  startedAt: number;
  endedAt?: number;
  lastUpdate: number;
  /** Live one-liner of what the run is doing right now. */
  currentTool?: string;
  toolCount?: number;
  tokens?: number;
  /** Final report, present once the run finished. */
  summary?: string;
  /** Failure reason, present when the run failed. */
  error?: string;
  /** Recent output lines, oldest first, capped. */
  tail: string[];
}

export const SUBAGENT_RUNS_TYPE = 'subagent_runs';
