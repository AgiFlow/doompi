/**
 * Plain-text renderings for the `subagent` status action, for the MODEL rather
 * than for a terminal.
 *
 * STATUS CONTRACT:
 * - `{ action: "status" }` returns the fleet overview
 * - `{ action: "status", id }` returns one run's state
 * - `{ action: "status", id, transcriptLines }` returns a bounded transcript tail
 *
 * There is no `view` discriminator. The schema rejects unknown fields, so every
 * recovery example must use one of the exact shapes above.
 *
 * WHY THIS IS NOT `tui/fleet.ts` OR `renderFleetTranscript`:
 * Those exist, they are correct, and they are wired to the `/fleet` slash
 * command, but each takes a `Theme` and emits ANSI escapes for a human reader.
 * A tool result is read by a model, where escape sequences are noise. This
 * module reuses the pure transcript reader and formats model-facing text.
 *
 * DELIBERATELY NOT SUPPORTED: `index`.
 * A fanout child is its own run with its own id, not an index into another run.
 * Accepting and ignoring an index would create a false affordance.
 */

import type { AsyncRunStatus } from '../../runs/background/asyncExecution';
import type { TrackedAsyncJob } from '../../asyncJobTracker';
import { isSuspendedRunResumable, type SuspendedRun } from '../../suspendedRuns';
import { formatDuration } from '../tui/formatters';
import { type FleetTranscriptEvent, readFleetTranscript } from '../tui/fleetTranscript';

/** Default transcript tail length. Matches the value the tool description has always advertised. */
export const DEFAULT_TRANSCRIPT_LINES = 80;

function age(job: TrackedAsyncJob, now: number): string {
  return job.startedAt ? formatDuration(Math.max(0, now - job.startedAt)) : 'unknown';
}

/**
 * The active-fleet overview: every run this session is tracking, one per line.
 *
 * Takes `now` rather than calling `Date.now()` so a test asserting rendered
 * ages does not have to freeze global time.
 */
export function formatFleetView(
  jobs: TrackedAsyncJob[],
  now: number = Date.now(),
  suspended: SuspendedRun[] = [],
): string {
  if (jobs.length === 0 && suspended.length === 0) {
    return 'No runs tracked in this session. A run appears here once it has been launched from this session.';
  }

  const lines = [`${jobs.length} active run${jobs.length === 1 ? '' : 's'}:`];
  for (const job of jobs) {
    const parts = [`- ${job.runId}`, job.status ?? 'starting', age(job, now)];
    if (job.activityState) parts.push(job.activityState);
    if (job.attentionReason) parts.push(job.attentionReason);
    if (job.error) parts.push(`error: ${job.error}`);
    lines.push(parts.join(' · '));
  }
  if (suspended.length > 0) {
    lines.push('', `${suspended.length} suspended run${suspended.length === 1 ? '' : 's'}:`);
    for (const run of suspended) {
      const recovery = isSuspendedRunResumable(run)
        ? `restore with { action: "restore", id: "${run.runId}" }`
        : 'not resumable; submit a new explicit run';
      lines.push(`- ${run.runId} (${run.agent}, ${run.runtime}): ${recovery}`);
    }
  }
  if (jobs.length > 0) {
    lines.push('');
    lines.push(`Inspect one with { action: "status", id: "<run id>", transcriptLines: ${DEFAULT_TRANSCRIPT_LINES} }.`);
  }
  return lines.join('\n');
}

/** Tool output shown to the model, bounded so one long result cannot crowd out the rest of the tail. */
const TOOL_RESULT_PREVIEW_LINES = 5;

function formatEvent(event: FleetTranscriptEvent): string {
  if (event.kind === 'tool') {
    const status = event.status === 'running' ? '…' : event.status === 'error' ? 'error' : 'ok';
    const args = event.args ? JSON.stringify(event.args) : event.text;
    const header = `[tool ${status}] ${event.name ?? 'tool'}${args ? ` ${args}` : ''}`;
    const result = event.result?.trimEnd();
    if (!result) return header;
    // The result is the half the model most needs: it is what the call
    // actually learned, and it used to be dropped entirely.
    const body = result.split('\n');
    const shown = body.slice(0, TOOL_RESULT_PREVIEW_LINES);
    const hidden = body.length - shown.length;
    return [header, ...shown.map((line) => `  ${line}`), hidden > 0 ? `  … +${hidden} lines` : undefined]
      .filter((line): line is string => line !== undefined)
      .join('\n');
  }
  return `[${event.kind}] ${event.text}`;
}

/**
 * A run's transcript tail.
 *
 * Bounded from the END, not the start: a caller asking for 80 lines of a
 * long-running child wants the most recent 80, not the first 80 of its
 * startup. When the window drops anything, the fact that it did is stated,
 * so a reader never mistakes a tail for the whole run.
 */
export function formatRunTranscript(status: AsyncRunStatus | undefined, maxLines: number): string {
  const transcriptPath = status?.transcriptPath;
  if (!transcriptPath) {
    return status
      ? 'This run has no transcript. Artifacts were disabled for it (artifacts: false), so nothing was recorded.'
      : 'No status found for this run, so there is no transcript to read.';
  }

  const transcript = readFleetTranscript(transcriptPath);
  if (transcript.warning) {
    return `Transcript at '${transcriptPath}' could not be read: ${transcript.warning}`;
  }
  if (transcript.events.length === 0) {
    return `Transcript at '${transcriptPath}' is empty. The run has not written anything yet.`;
  }

  const rendered = transcript.events.flatMap((event) => formatEvent(event).split('\n'));
  const kept = rendered.slice(-maxLines);
  const dropped = rendered.length - kept.length;
  const header =
    dropped > 0
      ? `Last ${kept.length} of ${rendered.length} transcript lines (${dropped} earlier line(s) not shown):`
      : `Transcript (${kept.length} line(s)):`;
  return [header, '', ...kept].join('\n');
}
