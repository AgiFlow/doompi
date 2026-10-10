/**
 * The workflow session: the child session a launch creates to own and run one
 * workflow, nested under the session that launched it.
 *
 * DESIGN PATTERNS:
 * - Pure presenters for the rail line and the owner agent's brief
 * - A lifecycle driven by the run snapshots the runtime already publishes,
 *   with every host effect injected
 *
 * AVOID:
 * - Posting or releasing on startup: a woken session reports nothing it did
 *   not see change, so opening a stopped session never stops it again
 */

import { basename } from 'node:path';

import type { DoomSessionActivity } from '@agimon-ai/doompi-core/hubChannel';

import { WORKFLOW_SESSION_PROVENANCE } from '../../constants/workflow';
import type { WorkflowRunView } from '../../types/webWorkflows';
import type { WorkflowSessionLifecycle, WorkflowSessionLifecycleDeps, WorkflowSessionNotice } from './type';

export type { WorkflowSessionLifecycle, WorkflowSessionLifecycleDeps, WorkflowSessionNotice } from './type';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** A failure cause is a line in a notice, not the log; a longer one is cut. */
const MAX_CAUSE = 1_000;
const WORKFLOW_FILE_SUFFIX = /\.workflow\.ya?ml$|\.ya?ml$/u;

/** Whether this session was created to own a workflow run. */
export function isWorkflowSession(context: { readonly sessionContext?: { readonly provenance?: string } }): boolean {
  return context.sessionContext?.provenance === WORKFLOW_SESSION_PROVENANCE;
}

/** The rail name of a workflow session: the catalog's name, else the file's stem. */
export function workflowSessionName(workflowPath: string, catalogName?: string): string {
  if (catalogName !== undefined && catalogName.trim() !== '') return catalogName.trim();
  return basename(workflowPath).replace(WORKFLOW_FILE_SUFFIX, '') || 'workflow';
}

function isPaused(run: WorkflowRunView): boolean {
  return run.stage === 'running' && (run.executionState === 'paused' || run.executionState === 'pause_requested');
}

function needsAttention(run: WorkflowRunView): boolean {
  return run.stage === 'error' || run.stale === true || isPaused(run);
}

function succeeded(run: WorkflowRunView): boolean {
  return (
    run.stage === 'completed' && (run.outcome === undefined || run.outcome === 'success' || run.outcome === 'skipped')
  );
}

function duration(run: WorkflowRunView): string | undefined {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt === undefined ? Number.NaN : Date.parse(run.finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const elapsed = Math.max(0, end - start);
  if (elapsed < MINUTE_MS) return 'under a minute';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  return `${Math.floor(elapsed / HOUR_MS)}h ${String(Math.floor((elapsed % HOUR_MS) / MINUTE_MS)).padStart(2, '0')}m`;
}

/**
 * The line the rail shows for a workflow session, in place of an idle agent's
 * copy. A failure or pause outranks a run in progress, because it is the one
 * that needs the reader.
 */
export function workflowSessionActivity(runs: readonly WorkflowRunView[]): DoomSessionActivity | undefined {
  if (runs.length === 0) return undefined;
  const failed = runs.find((run) => run.stage === 'error');
  if (failed !== undefined)
    return { label: `workflow failed · ${failed.failedJob ?? failed.displayName}`, attention: true };
  const paused = runs.find(isPaused);
  if (paused !== undefined) {
    return {
      label: paused.position === undefined ? 'workflow paused' : `workflow paused · ${paused.position.job}`,
      attention: true,
    };
  }
  const stale = runs.find((run) => run.stage === 'running' && run.stale === true);
  if (stale !== undefined) return { label: 'workflow interrupted', attention: true };
  const running = runs.find((run) => run.stage === 'running');
  if (running !== undefined) {
    const where = [running.position?.job, running.position?.step].filter(Boolean).join(' › ');
    return { label: where === '' ? 'workflow · starting' : `workflow · ${where}`, since: running.startedAt };
  }
  if (runs.every(succeeded)) return { label: 'workflow succeeded' };
  return { label: `workflow ${runs[0]!.outcome ?? 'ended'}`, attention: true };
}

function runState(run: WorkflowRunView): string {
  if (run.stage === 'error') return 'failed';
  if (run.stale === true) return 'interrupted (its process is gone)';
  if (isPaused(run)) return 'paused';
  if (run.stage === 'running') return 'running';
  return run.outcome ?? 'completed';
}

/**
 * The owner agent's live brief, added to its system prompt on every turn.
 *
 * Read from the registry each time rather than written once, so it survives a
 * wake and never describes a run that has since moved on.
 */
export function workflowSessionBrief(runs: readonly WorkflowRunView[]): string {
  if (runs.length === 0) return '';
  const lines = runs.map((run) => {
    const where = [run.position?.job, run.position?.step].filter(Boolean).join(' › ');
    const failure =
      run.stage === 'error'
        ? `; ${run.failedJob === undefined ? '' : `job '${run.failedJob}' `}failed: ${run.errorMessage ?? 'no cause recorded'}`
        : '';
    return `- ${run.displayName} (runKey ${run.runKey}, workspace ${run.workspace}): ${runState(run)}${where === '' ? '' : ` at ${where}`}${failure}`;
  });
  return [
    '# Workflow session',
    'You are the owner agent of this workflow session. It runs the workflow below for the session that launched it, and you troubleshoot it.',
    ...lines,
    'When a failure is reported to you, diagnose it: read workflow_tools recovery-evidence and workflow_run status with the runKey and workspace, then report the cause and recovery options here. Do not automatically forward diagnostics to the launcher. A user-requested stop needs no failure diagnosis and must not be restarted automatically. Load the workflow-recovery skill before workflow_tools recover. Recover, pause, resume or stop a run only when the user asks or the launcher explicitly delegates it through intercom.',
  ].join('\n');
}

function failureNotice(run: WorkflowRunView): WorkflowSessionNotice {
  const cause = (run.errorMessage ?? 'the run ended in the error stage').slice(0, MAX_CAUSE);
  const job = run.failedJob === undefined ? '' : ` at job "${run.failedJob}"`;
  return {
    title: 'Workflow failed',
    body: `Workflow "${run.displayName}" failed${job}: ${cause}. Ask me to diagnose or recover it.`,
    level: 'error',
  };
}

function finishNotice(run: WorkflowRunView): WorkflowSessionNotice {
  const took = duration(run);
  if (succeeded(run)) {
    return {
      title: 'Workflow succeeded',
      body: `Workflow "${run.displayName}" ${run.outcome === 'skipped' ? 'was skipped' : 'succeeded'}${took === undefined ? '' : ` in ${took}`}.`,
      level: 'info',
    };
  }
  return {
    title: 'Workflow ended',
    body: `Workflow "${run.displayName}" ended: ${run.outcome ?? 'no outcome recorded'}. Ask me to look into it.`,
    level: 'error',
  };
}

const identity = (run: WorkflowRunView): string => `${run.workspace}/${run.runKey}`;

/**
 * What a workflow session does as its runs move: keep the rail line current,
 * post a notice when a handed-off run fails or finishes, and ask its parent to
 * release it after an untouched success.
 *
 * "Untouched" means no run ever needed attention and nobody started a turn
 * here. A session you are reading or troubleshooting stays live until you
 * remove it.
 */
export function createWorkflowSessionLifecycle(deps: WorkflowSessionLifecycleDeps): WorkflowSessionLifecycle {
  const stages = new Map<string, WorkflowRunView['stage']>();
  let seeded = false;
  let attention = false;
  let engaged = false;
  let requested = false;
  let disposed = false;
  let stopWaiting: (() => void) | undefined;

  const releasable = (runs: readonly WorkflowRunView[]): boolean =>
    deps.parentSessionId !== undefined &&
    !attention &&
    !engaged &&
    !disposed &&
    runs.length > 0 &&
    runs.every(succeeded) &&
    runs.some((run) => run.launcherSessionId === deps.parentSessionId);

  const requestRelease = async (runs: readonly WorkflowRunView[]): Promise<void> => {
    const parent = deps.parentSessionId;
    if (parent === undefined || requested || deps.requestRelease === undefined || !releasable(runs)) return;
    if (!(await deps.isIdle())) return;
    requested = true;
    const runKeys = runs.map((run) => run.runKey);
    if (deps.requestRelease(parent, runKeys)) return;
    // ponytail: one retry when the parent can hear again; a parent that never returns leaves this session live.
    stopWaiting = deps.onPeerReady?.((peer) => {
      if (peer !== parent) return;
      stopWaiting?.();
      stopWaiting = undefined;
      if (releasable(runs)) deps.requestRelease?.(parent, runKeys);
    });
  };

  return {
    async observe(runs) {
      if (disposed) return;
      deps.publishActivity?.(workflowSessionActivity(runs));
      if (runs.some(needsAttention)) attention = true;
      if (!seeded) {
        for (const run of runs) stages.set(identity(run), run.stage);
        seeded = true;
        return;
      }
      let finished = false;
      for (const run of runs) {
        const previous = stages.get(identity(run));
        stages.set(identity(run), run.stage);
        // Only runs handed to this session get a notice: one its own agent launched reports to that agent.
        if (previous === run.stage || run.launcherSessionId === undefined) continue;
        if (run.stage === 'error') await deps.postNotice(failureNotice(run));
        else if (run.stage === 'completed') {
          await deps.postNotice(finishNotice(run));
          finished = true;
        }
      }
      if (finished) await requestRelease(runs);
    },
    agentStarted() {
      engaged = true;
    },
    dispose() {
      disposed = true;
      stopWaiting?.();
      stopWaiting = undefined;
    },
  };
}
