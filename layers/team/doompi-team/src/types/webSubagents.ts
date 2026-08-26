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

/** Where an agent definition came from; the catalog groups by it, nearest first. */
export type SubagentCatalogSource = 'project' | 'user' | 'plugin';

/** One launchable agent, as the catalog lists it. */
export interface SubagentCatalogAgent {
  name: string;
  source: SubagentCatalogSource;
  /** The package that staged a plugin agent. */
  packageName?: string;
  description: string;
  /** The model the definition pins; absent means the runtime's default. */
  model?: string;
  fallbackModels: string[];
  /** Empty means the definition does not narrow the tool set. */
  tools: string[];
  skills: string[];
  extensions: string[];
  defaultContext: 'fresh' | 'fork';
  filePath: string;
}

/** The 'subagent_catalog' channel payload: the agents a session's directory can launch. */
export interface SubagentCatalogPayload {
  cwd: string;
  agents: SubagentCatalogAgent[];
  /** Model specs the active team package offers, for the launch dialog's picker. */
  models: string[];
  /** Why the list may be incomplete, when discovery failed. */
  warning?: string;
}

export const SUBAGENT_CATALOG_TYPE = 'subagent_catalog';
