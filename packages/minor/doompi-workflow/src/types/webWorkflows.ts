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

/**
 * One workflow the session's directory can launch, as the catalog drawer
 * lists it: the engine's own catalog entry plus the parsed detail the drawer
 * unfolds and the launch dialog turns into fields.
 */
export interface WorkflowCatalogEntryView {
  /** Absolute path, the row's stable identity. */
  path: string;
  relativePath: string;
  name: string;
  description: string;
  tags: string[];
  /** The trigger names the file declares, such as workflow_dispatch. */
  triggers: string[];
  inputs: WorkflowCatalogInputView[];
  jobs: WorkflowCatalogJobView[];
  artifacts: WorkflowCatalogArtifactView[];
  /** Absent when the workflow names no runner map, which means any runner will do. */
  runners?: string[];
  /** Set when the file could not be parsed; the row shows this instead of guessing. */
  error?: string;
}

export interface WorkflowCatalogInputView {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
  type?: string;
  options?: string[];
}

export interface WorkflowCatalogJobView {
  name: string;
  runsOn?: string;
  steps: string[];
}

export interface WorkflowCatalogArtifactView {
  path: string;
  kind: 'file' | 'directory';
  description: string;
  producedBy: string[];
}

/** What the catalog channel publishes for one session. */
export interface WorkflowCatalogPayload {
  /** The directory the catalog was read from, which is the session's own. */
  cwd: string;
  workflows: WorkflowCatalogEntryView[];
  /** Present when the directory could not be read at all. */
  warning?: string;
}

export const WORKFLOW_CATALOG_TYPE = 'workflow_catalog';
