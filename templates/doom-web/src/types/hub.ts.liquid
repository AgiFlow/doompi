import type { BridgeState, SessionFrame } from './session.ts';

/**
 * Wire vocabulary between the hub and its pages.
 *
 * One WebSocket carries every session: hub-level frames describe the set of
 * sessions, and session-scoped traffic travels enveloped with the session id.
 * Field naming follows @earendil-works/pi-protocol so a future swap to the
 * upstream session server stays a transport change, not a rename.
 */
export const HUB_PROTOCOL_VERSION = 1;

/** Role marker in the health payload; doompi-server probes for it before binding the port. */
export const HUB_ROLE = 'hub';

/** REST endpoint for creating sessions; the page posts {cwd, name?} and receives {sessionId}. */
export const SESSIONS_API_ROUTE = '/api/sessions';

/** What the agent is doing right now, derived from its frame stream. */
export type SessionPhase = 'idle' | 'turn' | 'compaction' | 'retry';

export interface SessionGitStatus {
  branch: string;
  /** True when the working tree has uncommitted changes; rendered as a star. */
  dirty: boolean;
}

/**
 * Everything the rail needs to render one session without subscribing to it.
 */
export interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  /** ISO 8601, from the session's registry record. */
  createdAt: string;
  /** ISO 8601, bumped whenever the session's frame stream moves. */
  updatedAt: string;
  phase: SessionPhase;
  /** ISO 8601 timestamp of the last phase change; drives "running · 12m". */
  phaseSince: string;
  /** The hub's own attachment to the session socket. */
  attach: BridgeState;
  /** Human-readable cause, present when attach is refused or closed. */
  attachReason?: string;
  pendingMessageCount: number;
  /** False until the first prompt is forwarded; "fresh session · nothing sent yet". */
  everPrompted: boolean;
  /** True while the agent waits on a dialog answer; "waiting for your input". */
  awaitingInput: boolean;
  /** ISO 8601 of the last settled run, once one finished. */
  lastSettledAt?: string;
  /** Shown in the refused overlay so the user can find the competing client. */
  socketPath: string;
  /** Omitted when the cwd is not a git repository or git is unavailable. */
  git?: SessionGitStatus;
}

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

/** The focused session's fleet; sent on subscribe and whenever a status file changes. */
export interface SubagentRunsFrame {
  type: typeof SUBAGENT_RUNS_TYPE;
  sessionId: string;
  runs: SubagentRun[];
}

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

/** The focused session's workflow runs; sent on subscribe and whenever the registry changes. */
export interface WorkflowRunsFrame {
  type: typeof WORKFLOW_RUNS_TYPE;
  sessionId: string;
  runs: WorkflowRunView[];
}

export const HUB_HELLO_TYPE = 'hub_hello';
export const SESSIONS_SNAPSHOT_TYPE = 'sessions_snapshot';
export const SESSION_UPSERT_TYPE = 'session_upsert';
export const SESSION_REMOVED_TYPE = 'session_removed';
export const SESSION_BACKLOG_TYPE = 'session_backlog';
export const SESSION_FRAME_TYPE = 'session_frame';
export const SUBSCRIBE_TYPE = 'subscribe';
export const UNSUBSCRIBE_TYPE = 'unsubscribe';
export const SESSION_COMMAND_TYPE = 'session_command';

/** First frame on every page socket, before the snapshot. */
export interface HubHelloFrame {
  type: typeof HUB_HELLO_TYPE;
  protocol: number;
}

export interface SessionsSnapshotFrame {
  type: typeof SESSIONS_SNAPSHOT_TYPE;
  sessions: SessionSummary[];
}

export interface SessionUpsertFrame {
  type: typeof SESSION_UPSERT_TYPE;
  session: SessionSummary;
}

export interface SessionRemovedFrame {
  type: typeof SESSION_REMOVED_TYPE;
  sessionId: string;
}

/** Reply to subscribe: recent history from the hub's ring, then live frames follow. */
export interface SessionBacklogFrame {
  type: typeof SESSION_BACKLOG_TYPE;
  sessionId: string;
  frames: SessionFrame[];
  /** Frames the bounded ring had to discard before this page subscribed. */
  dropped: number;
}

/** One live agent frame, addressed to subscribers of its session. */
export interface SessionFrameEnvelope {
  type: typeof SESSION_FRAME_TYPE;
  sessionId: string;
  frame: SessionFrame;
}

export interface SubscribeFrame {
  type: typeof SUBSCRIBE_TYPE;
  sessionId: string;
}

export interface UnsubscribeFrame {
  type: typeof UNSUBSCRIBE_TYPE;
  sessionId: string;
}

/** One command frame from the page, addressed to a session's agent. */
export interface SessionCommandFrame {
  type: typeof SESSION_COMMAND_TYPE;
  sessionId: string;
  frame: SessionFrame;
}

export function hubHello(): HubHelloFrame {
  return { type: HUB_HELLO_TYPE, protocol: HUB_PROTOCOL_VERSION };
}

export function sessionFrameEnvelope(sessionId: string, frame: SessionFrame): SessionFrameEnvelope {
  return { type: SESSION_FRAME_TYPE, sessionId, frame };
}

export function sessionCommand(sessionId: string, frame: SessionFrame): SessionCommandFrame {
  return { type: SESSION_COMMAND_TYPE, sessionId, frame };
}

export function subscribeFrame(sessionId: string): SubscribeFrame {
  return { type: SUBSCRIBE_TYPE, sessionId };
}

export function unsubscribeFrame(sessionId: string): UnsubscribeFrame {
  return { type: UNSUBSCRIBE_TYPE, sessionId };
}
