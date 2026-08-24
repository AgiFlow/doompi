/**
 * Workflow run view types shared by this package's hub channel and its web
 * plugin. The shapes mirror what the embedded workflow-mcp engine records;
 * the cockpit renders them as 'workflow_runs' channel payloads.
 */

/** workflow-mcp's own stage vocabulary; the registry bucket a run record sits in. */
export type WorkflowStage = 'running' | 'completed' | 'error';

/** workflow-mcp's terminal outcome for a finished run. */
export type WorkflowOutcome = 'success' | 'skipped' | 'failed' | 'interrupted';

/** Job and step states as workflow-mcp records them in the progress log. */
export type WorkflowProgressState =
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'pause_requested'
  | 'paused'
  | 'resumed';

export interface WorkflowStepView {
  name: string;
  status: WorkflowProgressState;
  /** Why the step is in its state, when the engine recorded one (e.g. a skip condition). */
  reason?: string;
  /** ISO 8601 of the step's first running event. */
  startedAt?: string;
  /** ISO 8601 of the step's terminal event. */
  endedAt?: string;
}

/** 'pre' and 'post' are the engine's pseudo-jobs for its pre:/post: blocks. */
export type WorkflowJobPhase = 'pre' | 'job' | 'post';

export interface WorkflowJobView {
  name: string;
  phase: WorkflowJobPhase;
  status: WorkflowProgressState;
  reason?: string;
  /** Position among the run's jobs, when the engine recorded one. */
  index?: number;
  total?: number;
  startedAt?: string;
  endedAt?: string;
  steps: WorkflowStepView[];
}

/** The job and step a run is on right now; drives the NOW breadcrumb. */
export interface WorkflowPosition {
  job: string;
  step?: string;
  index?: number;
  total?: number;
}

/**
 * One workflow run of a session, read from workflow-mcp's registry: the
 * run.json record plus the folded progress.ndjson job tree.
 */
export interface WorkflowRunView {
  /** Registry identity within its workspace; unique per workspace+stage. */
  runKey: string;
  workspace: string;
  displayName: string;
  workflowName?: string;
  workflowPath: string;
  stage: WorkflowStage;
  outcome?: WorkflowOutcome;
  /** Present while the engine is pausing or paused; absent for plain running. */
  executionState?: 'running' | 'pause_requested' | 'paused' | 'resume_requested';
  /** The prompt the run was launched with, when one was recorded. */
  prompt?: string;
  /** ISO 8601, from the run record. */
  startedAt: string;
  finishedAt?: string;
  /** Failure cause with ANSI escapes stripped, present when the run errored. */
  errorMessage?: string;
  /** The job the engine blamed for the failure, when it recorded one. */
  failedJob?: string;
  /** True when reconciliation decided the recorded pid is no longer alive. */
  stale?: boolean;
  staleReason?: string;
  worktreeBranch?: string;
  position?: WorkflowPosition;
  jobs: WorkflowJobView[];
}

export const WORKFLOW_RUNS_TYPE = 'workflow_runs';
