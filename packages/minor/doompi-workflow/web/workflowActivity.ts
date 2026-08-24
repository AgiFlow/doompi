import type { WorkflowRunView } from '../src/types/webWorkflows.ts';
import { formatRunDuration } from './runDuration.ts';

export type WorkflowActivityTone = 'running' | 'paused' | 'failed' | 'done' | 'skipped';

/** One run as the activity dock lists it: identity, a tone, and a one-liner. */
export interface WorkflowActivityRow {
  /** Registry identity: workspace/runKey, unique across the session's runs. */
  identity: string;
  runKey: string;
  name: string;
  tone: WorkflowActivityTone;
  elapsed: string;
  /** Where the run is right now, or how it ended. */
  detail: string;
}

const PAUSED_STATES: ReadonlySet<NonNullable<WorkflowRunView['executionState']>> = new Set([
  'paused',
  'pause_requested',
]);

export function workflowRunIdentity(run: Pick<WorkflowRunView, 'workspace' | 'runKey'>): string {
  return `${run.workspace}/${run.runKey}`;
}

function toneOf(run: WorkflowRunView): WorkflowActivityTone {
  if (run.stage === 'running') {
    return run.executionState !== undefined && PAUSED_STATES.has(run.executionState) ? 'paused' : 'running';
  }
  if (run.stage === 'error') return 'failed';
  if (run.outcome !== undefined && run.outcome !== 'success') return run.outcome === 'failed' ? 'failed' : 'skipped';
  return 'done';
}

function detailOf(run: WorkflowRunView, tone: WorkflowActivityTone): string {
  if (tone === 'paused') return 'paused; resume it from the owning session';
  if (tone === 'failed')
    return run.errorMessage ?? (run.failedJob === undefined ? 'failed' : `job '${run.failedJob}' failed`);
  if (tone === 'running') {
    if (run.position === undefined) return 'starting';
    return run.position.step === undefined ? run.position.job : `${run.position.job} · ${run.position.step}`;
  }
  return run.outcome ?? 'done';
}

function elapsedOf(run: WorkflowRunView, now: number): string {
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return '';
  const end = run.finishedAt === undefined ? now : Date.parse(run.finishedAt);
  return formatRunDuration(Math.max(0, (Number.isFinite(end) ? end : now) - start));
}

/** The hub's presented order is kept: it already puts live runs first. */
export function workflowActivityRows(runs: readonly WorkflowRunView[], now: number): WorkflowActivityRow[] {
  return runs.map((run) => {
    const tone = toneOf(run);
    return {
      identity: workflowRunIdentity(run),
      runKey: run.runKey,
      name: run.displayName,
      tone,
      elapsed: elapsedOf(run, now),
      detail: detailOf(run, tone),
    };
  });
}
