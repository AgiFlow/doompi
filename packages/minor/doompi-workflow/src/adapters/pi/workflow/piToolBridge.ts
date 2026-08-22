/**
 * Pure bridging logic between MCP tool results and the Pi tool surface.
 *
 * DESIGN PATTERNS:
 * - Adapter pattern: MCP `CallToolResult` is converted to Pi's result shape
 * - Pure module: no service or tool-class imports, so this is unit-testable
 *   without constructing the workflow execution stack
 *
 * CODING STANDARDS:
 * - Named exports only
 * - Explicit return types on exported functions
 *
 * AVOID:
 * - Importing tool classes or services here (that belongs in `piTools.ts`)
 * - Returning an error flag Pi does not read; Pi tools signal failure by throwing
 */

import type { WorkflowProgressJob, WorkflowRunRecord } from '@agimon-ai/workflow-mcp';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Environment variable stamped onto every run launched from a Pi session.
 *
 * `RunWorkflowService` forwards `env` to the inner CLI invocation across the
 * `launch-command` delegation boundary and persists it on the run record, so
 * this survives backgrounding and identifies the launching session afterwards.
 */
export const PI_SESSION_ENV = 'PI_SESSION_ID';

/** Operator override for the per-session launch ceiling. */
const MAX_CONCURRENT_ENV = 'WORKFLOW_MCP_MAX_CONCURRENT';
const DEFAULT_MAX_CONCURRENT = 5;

export interface WorkflowToolDetails {
  tool: string;
}

/** Resolve the per-session launch ceiling from the environment. */
export function resolveMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[MAX_CONCURRENT_ENV]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT;
}

/**
 * True when this session launched the run.
 *
 * Fails closed on a missing session id: an unstamped record (a CLI launch) and
 * a call arriving before the session id is known both match nothing, so no run
 * ever leaks across sessions through an undefined-equals-undefined comparison.
 */
export function isSessionRun(record: WorkflowRunRecord, sessionId: string | undefined): boolean {
  return sessionId !== undefined && record.env?.[PI_SESSION_ENV] === sessionId;
}

/** Runs launched by one Pi session that are still running. */
export function runsForSession(records: WorkflowRunRecord[], sessionId: string): WorkflowRunRecord[] {
  return records.filter((record) => isSessionRun(record, sessionId) && record.stage === 'running');
}

/**
 * What the caller is told when the registry, not the launcher, acknowledged a
 * launch.
 *
 * Leads with the run key because it is the handle every other workflow action
 * takes, and it is no longer available any other way: the launcher's own output
 * is not waited for, so nothing else in this result carries it.
 */
export function launchedRunSummary(record: WorkflowRunRecord): string {
  return [
    `Started ${record.displayName} in workspace ${record.workspace}.`,
    `Run key: ${record.runKey}`,
    'The run is registered and going. This call returned at that point rather than waiting for the launcher process to exit.',
  ].join('\n');
}

/**
 * What the caller is told when the launch was handed off but no run has
 * registered inside the acknowledgement budget.
 *
 * Deliberately not an error: the launcher is slow rather than broken often
 * enough that failing here would strand runs that go on to start normally.
 * There is no run key to offer yet, so it points at the surfaces that do not
 * need one.
 */
export function launchHandoffSummary(workflowPath: string): string {
  return [
    `Launch handed off for ${workflowPath}, but no run has registered yet.`,
    'Nothing was cancelled: the launcher is still starting, and a run that registers later still reports back here when it finishes.',
    'Do not launch it again. Ask the user to check the active workflow list if they need to see it sooner.',
  ].join('\n');
}

/**
 * Escape sequences a terminal consumes rather than prints.
 *
 * Built from a string with the rule silenced, the way `doom-runner`'s own
 * scrubber does it, because matching the escape byte is the entire job. Not
 * imported from there: that package's published build is a stale artifact
 * missing the export, and a launch notice should not need another package's
 * build to be current.
 */
// oxlint-disable-next-line no-control-regex -- matching terminal control bytes is the point
const ESCAPE_SEQUENCE = new RegExp(
  ['\\u001B\\[[0-9;?]*[ -/]*[@-~]', '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)', '\\u001B[@-Z\\\\-_]'].join(
    '|',
  ),
  'g',
);

/** Rows made only of box-drawing: separators that carry nothing once trimmed. */
const RULE_ROW = /^[\s─-╿]*$/u;
const NOTICE_LINE_LIMIT = 3;
/**
 * Widest a notice row may be before it is clipped.
 *
 * A three-line cap does not bound a toast on its own: the engine announces its
 * delegation by echoing the whole shell command, temp script path included, and
 * one line of that wraps across three rows of a narrow terminal and shoves the
 * transcript around. Clipped at a width every terminal can hold instead.
 */
const NOTICE_WIDTH_LIMIT = 100;

/**
 * Cut a tool result down to something a toast can hold.
 *
 * The launch result used to reach `ui.notify` whole, and for a workflow that
 * executes in this process that result is the engine's entire console log:
 * banner, run directory, job tree, rules, colour. Pi rendered every line of it
 * over the transcript, which reads as a broken screen rather than as output.
 * Escape sequences go first: the log carries colour the notification would
 * render as literal text, and a stray clear or cursor-move would do to the
 * screen exactly what this function exists to prevent.
 */
export function launchNotice(text: string, limit: number = NOTICE_LINE_LIMIT): string {
  const lines = text
    .replace(ESCAPE_SEQUENCE, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !RULE_ROW.test(line))
    .map((line) => (line.length > NOTICE_WIDTH_LIMIT ? `${line.slice(0, NOTICE_WIDTH_LIMIT - 1)}…` : line));
  if (lines.length === 0) return 'Workflow started.';
  if (lines.length <= limit) return lines.join('\n');
  return [...lines.slice(0, limit), `… ${lines.length - limit} more lines, in the run's own output.`].join('\n');
}

/** Flatten MCP tool content to text for Pi. */
export function toolResultText(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Convert an MCP tool result into a Pi tool result.
 *
 * Pi signals tool failure by throwing: the agent loop catches it and builds the
 * error result. So an `isError` MCP result becomes a thrown error rather than a
 * successful result carrying a flag Pi would ignore.
 */
export function toAgentToolResult(
  tool: string,
  result: CallToolResult,
  errorOptions: string[] = [],
): AgentToolResult<WorkflowToolDetails> {
  const text = toolResultText(result) || 'No output.';
  if (result.isError) throw new Error(withOptions(text, errorOptions));
  return { content: [{ type: 'text', text }], details: { tool } };
}

/**
 * Attach a short menu of next steps to a problem.
 *
 * An error with no route forward is where an agent invents one: retrying a
 * capacity limit, relaunching a run that should be recovered, or silently
 * giving up on work the user is waiting for. Naming two or three real options
 * turns an error into a decision, and the decision belongs to the user.
 */
export function withOptions(problem: string, options: string[]): string {
  if (options.length === 0) return problem;
  return [problem, '', 'Options, put these to the user rather than picking one yourself:', ...options.map(bullet)].join(
    '\n',
  );
}

function bullet(option: string): string {
  return `- ${option}`;
}

/** The job and step a run died on, preferring the progress log to the record. */
function failurePosition(
  record: WorkflowRunRecord,
  jobs: WorkflowProgressJob[],
): { job?: string; step?: string; reason?: string } {
  // The progress log knows which step was in flight; the record only names the
  // job. Falling back keeps this working for runs that predate the log.
  const failedJob = jobs.find((job) => job.status === 'failed');
  const failedStep = failedJob?.steps.find((step) => step.status === 'failed');
  return {
    job: failedJob?.name ?? record.failedJob,
    step: failedStep?.name,
    reason: failedStep?.reason ?? failedJob?.reason,
  };
}

/**
 * Describe a finished run for the agent that launched it.
 *
 * Carries the job identifiers back so a dispatching agent can match the run to
 * the work item it launched it for without another lookup. When the run failed,
 * carries the failing step and a set of options too: the agent is being told
 * about this out of band, with no user question in flight, so without them it
 * has to guess whether to recover, relaunch, or report.
 */
export function finishedRunSummary(record: WorkflowRunRecord, jobs: WorkflowProgressJob[] = []): string {
  const outcome = record.stage === 'completed' ? 'completed' : `ended in ${record.stage}`;
  const failure = failurePosition(record, jobs);
  const lines: Array<string | undefined> = [
    `Workflow run ${record.runKey} in workspace ${record.workspace} ${outcome}.`,
    record.workflowId ? `Workflow: ${record.workflowId}` : undefined,
    failure.job ? `Failed job: ${failure.job}${failure.step ? ` (step: ${failure.step})` : ''}` : undefined,
    record.errorMessage ? `Error: ${record.errorMessage}` : undefined,
    failure.reason && failure.reason !== record.errorMessage ? `Step reported: ${failure.reason}` : undefined,
  ];
  const jobId = record.env?.AGIFLOW_JOB_ID;
  if (jobId) lines.push(`Agiflow job: ${record.env?.AGIFLOW_JOB_KIND ?? 'unknown'} ${jobId}`);

  const summary = lines.filter((line): line is string => Boolean(line)).join('\n');
  if (record.stage === 'completed') return summary;

  // A run the user stopped is not a defect, so it gets no diagnosis step: the
  // question is only whether to pick it back up.
  const stopped = record.outcome === 'interrupted';
  if (stopped) {
    return withOptions(summary, [
      `workflow_run {"action":"recover","runKey":${JSON.stringify(record.runKey)}}: pick it up where it stopped.`,
      'Leave it stopped and move on.',
    ]);
  }

  const diagnosticText = [record.errorMessage, failure.reason].filter(Boolean).join('\n');
  if (diagnosticText.includes('JOB_ALREADY_CLAIMED')) {
    return withOptions(summary, [
      'Report contention: another worker owns this job. Do not unlock, release, or retry the claim automatically.',
    ]);
  }
  if (diagnosticText.includes('WORKFLOW_NOT_OWNED') || /release failed/i.test(diagnosticText)) {
    return withOptions(summary, [
      'Inspect the current workflow ownership and ask the user before any release or unlock. Never force another worker’s lock.',
    ]);
  }
  if (/running workflow not found/i.test(diagnosticText)) {
    return withOptions(summary, [
      `workflow_run {"action":"status","runKey":${JSON.stringify(record.runKey)}}: re-check current state before retrying.`,
      'Report the recorded terminal state when no running owner remains.',
    ]);
  }

  return withOptions(summary, [
    `workflow_run {"action":"tail","runKey":${JSON.stringify(record.runKey)}}: read the run's own output first, when the error above does not explain the failure.`,
    `workflow_run {"action":"recover","runKey":${JSON.stringify(record.runKey)}}: resume from the failed job, keeping the work already done. Fits a transient or external cause.`,
    'Report the failure and stop, when it needs a code change or a decision you cannot make.',
  ]);
}
