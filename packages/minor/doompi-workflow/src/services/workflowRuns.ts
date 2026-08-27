import { resolve } from 'node:path';
import type {
  WorkflowJobPhase,
  WorkflowJobView,
  WorkflowOutcome,
  WorkflowPosition,
  WorkflowProgressState,
  WorkflowRunView,
  WorkflowStage,
  WorkflowStepView,
} from '../types/webWorkflows.ts';

/**
 * MIRRORS @agimon-ai/workflow-mcp's on-disk registry
 * (src/services/WorkflowRegistryService.ts and WorkflowProgressService.ts in
 * that package). The engine keeps one directory per run under
 * `<home>/workspaces/<workspace>/<stage>/<runKey>/` holding a `run.json`
 * record and an append-only `progress.ndjson` job/step log; the hub only ever
 * reads them. The derivation is duplicated rather than imported because
 * doompi-web must not depend on the engine at runtime; the unit suite pins
 * this mirror against the package's published types.
 */
const DEFAULT_WORKFLOW_HOME_DIR_NAME = '.workflow-mcp';
export const WORKFLOW_HOME_ENV = 'WORKFLOW_MCP_HOME';
export const WORKSPACES_DIR_NAME = 'workspaces';
export const RUN_RECORD_FILE_NAME = 'run.json';
export const PROGRESS_FILE_NAME = 'progress.ndjson';
export const WORKFLOW_STAGES: readonly WorkflowStage[] = ['running', 'completed', 'error'];

/**
 * Errored runs stay a day, which is how long recovery has to act on them.
 *
 * Finished runs have no retention of their own: a session keeps every run it
 * launched, grouped by outcome, for as long as the session lives. A run leaves
 * the view when the engine prunes its registry directory, not on a timer here,
 * because "what did this session run today" is a question asked long after the
 * run settled.
 */
export const WORKFLOW_ERROR_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Upper bound per outcome group rather than over the whole list.
 *
 * One cap across every run let a long stream of green runs push a failure out
 * of the list, which is the one thing that must never fall off the end.
 */
export const MAX_PRESENTED_WORKFLOW_RUNS_PER_GROUP = 24;

/** The env key doompi-workflow stamps on runs it launches; ties a run to a Pi session. */
export const PI_SESSION_ENV = 'PI_SESSION_ID';

const PROGRESS_STATES: ReadonlySet<string> = new Set([
  'running',
  'completed',
  'skipped',
  'failed',
  'pause_requested',
  'paused',
  'resumed',
]);
const OUTCOMES: ReadonlySet<string> = new Set(['success', 'skipped', 'failed', 'interrupted']);
const EXECUTION_STATES: ReadonlySet<string> = new Set(['running', 'pause_requested', 'paused', 'resume_requested']);
const STEP_TERMINAL_STATES: ReadonlySet<WorkflowProgressState> = new Set(['completed', 'skipped', 'failed']);
/** The engine records its pre:/post: blocks under these reserved pseudo-job names. */
const PHASE_JOB_PRE = 'pre';
const PHASE_JOB_POST = 'post';

// oxlint-disable-next-line no-control-regex -- stripping terminal color codes from errorMessage is the point
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export interface WorkflowHomeInput {
  /** process.env.WORKFLOW_MCP_HOME, supplied by the caller. */
  envValue: string | undefined;
  /** os.homedir(), supplied by the caller. */
  homeDir: string;
}

/** Where workflow-mcp keeps its registry, mirroring the engine's own resolution. */
export function resolveWorkflowHome(input: WorkflowHomeInput): string {
  return resolve(
    input.envValue !== undefined && input.envValue !== ''
      ? input.envValue
      : resolve(input.homeDir, DEFAULT_WORKFLOW_HOME_DIR_NAME),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '').trim();
}

/**
 * One run record plus the facts the hub needs for session scoping but the
 * page never sees.
 */
export interface ParsedWorkflowRun {
  /** The wire view, before the progress log is folded in (jobs empty). */
  view: WorkflowRunView;
  /** env.PI_SESSION_ID from the record, when the launcher stamped one. */
  piSessionId?: string;
}

/**
 * Validates one run.json into the wire shape plus scoping facts.
 *
 * Returns undefined for anything unreadable or a foreign format. The record
 * is trusted for its own stage: the registry rewrites it when a run moves
 * between stage directories.
 */
export function parseWorkflowRunRecord(raw: string): ParsedWorkflowRun | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const runKey = asOptionalString(parsed.runKey);
  const workspace = asOptionalString(parsed.workspace);
  const workflowPath = asOptionalString(parsed.workflowPath);
  const startedAt = asOptionalString(parsed.startedAt);
  const stage = asOptionalString(parsed.stage);
  if (!runKey || !workspace || !workflowPath || !startedAt) return undefined;
  if (stage === undefined || !WORKFLOW_STAGES.includes(stage as WorkflowStage)) return undefined;

  const outcome = asOptionalString(parsed.outcome);
  const executionState = asOptionalString(parsed.executionState);
  const rawError = asOptionalString(parsed.errorMessage);
  const env = isRecord(parsed.env) ? parsed.env : undefined;
  const view: WorkflowRunView = {
    runKey,
    workspace,
    displayName: asOptionalString(parsed.displayName) ?? runKey,
    ...(asOptionalString(parsed.workflowName) === undefined
      ? {}
      : { workflowName: asOptionalString(parsed.workflowName) }),
    workflowPath,
    stage: stage as WorkflowStage,
    ...(outcome !== undefined && OUTCOMES.has(outcome) ? { outcome: outcome as WorkflowOutcome } : {}),
    ...(executionState !== undefined && EXECUTION_STATES.has(executionState)
      ? { executionState: executionState as WorkflowRunView['executionState'] }
      : {}),
    ...(asOptionalString(parsed.prompt) === undefined ? {} : { prompt: asOptionalString(parsed.prompt) }),
    startedAt,
    ...(asOptionalString(parsed.finishedAt) === undefined ? {} : { finishedAt: asOptionalString(parsed.finishedAt) }),
    ...(rawError === undefined ? {} : { errorMessage: stripAnsi(rawError) }),
    ...(asOptionalString(parsed.failedJob) === undefined ? {} : { failedJob: asOptionalString(parsed.failedJob) }),
    ...(parsed.stale === true ? { stale: true } : {}),
    ...(asOptionalString(parsed.staleReason) === undefined
      ? {}
      : { staleReason: asOptionalString(parsed.staleReason) }),
    ...(asOptionalString(parsed.worktreeBranch) === undefined
      ? {}
      : { worktreeBranch: asOptionalString(parsed.worktreeBranch) }),
    jobs: [],
  };
  const piSessionId = env === undefined ? undefined : asOptionalString(env[PI_SESSION_ENV]);
  return { view, ...(piSessionId === undefined ? {} : { piSessionId }) };
}

interface WorkflowProgressEvent {
  type: 'job' | 'step';
  status: WorkflowProgressState;
  job: string;
  step?: string;
  index?: number;
  total?: number;
  reason?: string;
  at: string;
}

/**
 * Parses the append-only progress log. Malformed lines are skipped rather
 * than failing the file: a reader routinely catches a torn final line
 * mid-append.
 */
export function parseWorkflowProgress(raw: string): WorkflowProgressEvent[] {
  const events: WorkflowProgressEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const type = parsed.type;
    const status = asOptionalString(parsed.status);
    const job = asOptionalString(parsed.job);
    const at = asOptionalString(parsed.at);
    if ((type !== 'job' && type !== 'step') || !job || !at) continue;
    if (status === undefined || !PROGRESS_STATES.has(status)) continue;
    const step = asOptionalString(parsed.step);
    const index = asOptionalNumber(parsed.index);
    const total = asOptionalNumber(parsed.total);
    const reason = asOptionalString(parsed.reason);
    events.push({
      type,
      status: status as WorkflowProgressState,
      job,
      ...(step === undefined ? {} : { step }),
      ...(index === undefined ? {} : { index }),
      ...(total === undefined ? {} : { total }),
      ...(reason === undefined ? {} : { reason }),
      at,
    });
  }
  return events;
}

function jobPhase(name: string): WorkflowJobPhase {
  if (name === PHASE_JOB_PRE) return PHASE_JOB_PRE;
  if (name === PHASE_JOB_POST) return PHASE_JOB_POST;
  return 'job';
}

/**
 * Folds the event log into the current job tree; later events win, so a job
 * that started and later failed reads as failed. Jobs and steps keep the
 * order of their first appearance.
 */
export function foldWorkflowProgress(events: readonly WorkflowProgressEvent[]): WorkflowJobView[] {
  const jobs: WorkflowJobView[] = [];
  const jobByName = new Map<string, WorkflowJobView>();
  for (const event of events) {
    let job = jobByName.get(event.job);
    if (job === undefined) {
      job = { name: event.job, phase: jobPhase(event.job), status: event.status, steps: [] };
      jobByName.set(event.job, job);
      jobs.push(job);
    }
    if (event.type === 'job') {
      job.status = event.status;
      if (event.reason !== undefined) job.reason = event.reason;
      if (event.index !== undefined) job.index = event.index;
      if (event.total !== undefined) job.total = event.total;
      if (event.status === 'running' && job.startedAt === undefined) job.startedAt = event.at;
      if (STEP_TERMINAL_STATES.has(event.status)) job.endedAt = event.at;
      continue;
    }
    if (event.step === undefined) continue;
    let step: WorkflowStepView | undefined = job.steps.find((candidate) => candidate.name === event.step);
    if (step === undefined) {
      step = { name: event.step, status: event.status };
      job.steps.push(step);
    }
    step.status = event.status;
    if (event.reason !== undefined) step.reason = event.reason;
    if (event.status === 'running' && step.startedAt === undefined) step.startedAt = event.at;
    if (STEP_TERMINAL_STATES.has(event.status)) step.endedAt = event.at;
  }
  return jobs;
}

const ACTIVE_PROGRESS_STATES: ReadonlySet<WorkflowProgressState> = new Set([
  'running',
  'pause_requested',
  'paused',
  'resumed',
]);

/** The job and step a run is on right now, for the NOW breadcrumb. */
export function workflowPosition(jobs: readonly WorkflowJobView[]): WorkflowPosition | undefined {
  for (let jobIndex = jobs.length - 1; jobIndex >= 0; jobIndex -= 1) {
    const job = jobs[jobIndex]!;
    if (!ACTIVE_PROGRESS_STATES.has(job.status)) continue;
    for (let stepIndex = job.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const step = job.steps[stepIndex]!;
      if (ACTIVE_PROGRESS_STATES.has(step.status)) {
        return {
          job: job.name,
          step: step.name,
          ...(job.index === undefined ? {} : { index: job.index }),
          ...(job.total === undefined ? {} : { total: job.total }),
        };
      }
    }
    return {
      job: job.name,
      ...(job.index === undefined ? {} : { index: job.index }),
      ...(job.total === undefined ? {} : { total: job.total }),
    };
  }
  return undefined;
}

/** The finished view: record fields plus the folded job tree and position. */
export function completeWorkflowRunView(view: WorkflowRunView, jobs: WorkflowJobView[]): WorkflowRunView {
  const position = view.stage === 'running' ? workflowPosition(jobs) : undefined;
  return { ...view, jobs, ...(position === undefined ? {} : { position }) };
}

/**
 * Whether a run belongs on a session's workflow tab: launched by that Pi
 * session, which is the same env test doompi-workflow's isSessionRun applies.
 *
 * The registry is one directory under $HOME shared by every repository and
 * every Pi session on the machine, so repository proximity is not ownership.
 * Scoping on it as well let two sessions open in one repo read each other's
 * history, and kept a dead session's runs on the board of every session that
 * replaced it. Fails closed on an unstamped record, which is what a launch
 * from the CLI rather than from a session leaves behind.
 */
export function runBelongsToSession(run: ParsedWorkflowRun, sessionId: string): boolean {
  return run.piSessionId !== undefined && run.piSessionId === sessionId;
}

function parseTime(value: string | undefined): number {
  if (value === undefined) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

const STAGE_ORDER: Readonly<Record<WorkflowStage, number>> = { running: 0, error: 1, completed: 2 };

/**
 * Whether a run still belongs in the view.
 *
 * Only errored runs age out here, and slowly: everything else a session
 * started stays until the engine forgets the run itself.
 */
function withinRetention(run: WorkflowRunView, now: number): boolean {
  if (run.stage !== 'error') return true;
  const settledAt = parseTime(run.finishedAt) || parseTime(run.startedAt);
  return now - settledAt < WORKFLOW_ERROR_RETENTION_MS;
}

/**
 * When a run last moved, which is what orders it within its group.
 *
 * A running run has only its start; a settled one is ordered by when it
 * settled, because a list kept for the whole session is read as a history and
 * two runs started together can finish an hour apart.
 */
function lastMovedAt(run: WorkflowRunView): number {
  return run.stage === 'running' ? parseTime(run.startedAt) : parseTime(run.finishedAt) || parseTime(run.startedAt);
}

/**
 * Running runs first, then errored (recovery acts on them), then finished;
 * newest first within a group, and each group capped on its own.
 */
export function presentWorkflowRuns(runs: readonly WorkflowRunView[], now: number): WorkflowRunView[] {
  const groups = new Map<WorkflowStage, WorkflowRunView[]>();
  for (const run of runs) {
    if (!withinRetention(run, now)) continue;
    const group = groups.get(run.stage);
    if (group) group.push(run);
    else groups.set(run.stage, [run]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => STAGE_ORDER[left] - STAGE_ORDER[right])
    .flatMap(([, group]) =>
      group
        .sort((left, right) => lastMovedAt(right) - lastMovedAt(left))
        .slice(0, MAX_PRESENTED_WORKFLOW_RUNS_PER_GROUP),
    );
}
