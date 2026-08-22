/**
 * Session reporting for a run's progress log.
 *
 * DESIGN PATTERNS:
 * - Pure derivation. Takes a run's raw progress events and returns report lines,
 *   so the behaviour is unit-testable without a registry or a live run.
 *
 * CODING STANDARDS:
 * - Named exports only
 * - Explicit return types on exported members
 *
 * Live progress now renders through `workflowProgressOverlay.ts`. This module
 * remains the compatibility derivation used by terminal summaries and legacy
 * workflow-step cards already persisted in older sessions.
 */

import type { WorkflowProgressEvent } from '@agimon-ai/workflow-mcp';

/** Step names come from workflow YAML and can be sentences. */
const MAX_STEP_LABEL = 48;

/** One session line, plus the key that stops it being reported twice. */
export interface StepReport {
  duration?: string;
  job: string;
  key: string;
  status: 'FAILED' | 'FINISHED' | 'STARTED';
  step: string;
}

function truncateStep(step: string): string {
  return step.length <= MAX_STEP_LABEL ? step : `${step.slice(0, MAX_STEP_LABEL - 1)}…`;
}

/**
 * Human-scale duration.
 *
 * Rounded hard on purpose: this is read at a glance next to a step name, where
 * milliseconds are noise and "4m12s" answers the only question being asked.
 */
export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Turn a run's raw progress log into session report lines.
 *
 * Derives durations by pairing each step's start with its end rather than
 * recording a duration in the log, so nothing about the log format has to
 * change and old runs read back the same way.
 *
 * Keyed by the event's own timestamp so a caller polling the same append-only
 * file repeatedly reports each transition exactly once, however often it polls.
 */
export function stepReportLines(runKey: string, events: WorkflowProgressEvent[]): StepReport[] {
  const startedAt = new Map<string, string>();
  const reports: StepReport[] = [];

  for (const event of events) {
    if (event.type !== 'step' || !event.step) continue;
    const id = `${runKey}/${event.job}`;
    const stepKey = `${id}/${event.step}`;
    const label = truncateStep(event.step);

    if (event.status === 'running') {
      startedAt.set(stepKey, event.at);
      reports.push({ job: event.job, key: `started:${stepKey}:${event.at}`, status: 'STARTED', step: label });
      continue;
    }

    const began = startedAt.get(stepKey);
    const duration = began ? humanizeDuration(Date.parse(event.at) - Date.parse(began)) : '?';
    // A failed step did finish, but calling it FINISHED buries the one outcome
    // the reader needs to see. Same shape, honest verb.
    const status = event.status === 'failed' ? 'FAILED' : 'FINISHED';
    reports.push({ duration, job: event.job, key: `${status}:${stepKey}:${event.at}`, status, step: label });
  }

  return reports;
}
