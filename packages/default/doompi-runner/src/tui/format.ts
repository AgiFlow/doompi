import { formatUptime } from '../commands/bash/responseEnvelope.ts';
import type { RunnerRecord } from '../types/runnerRegistry';

export const WIDGET_KEY = 'doom-runners';
export const OVERLAY_HEADING = 'Runners';

/** Compact footer text. An absent value removes the group entirely. */
export function formatRunnerStatus(count: number): string | undefined {
  return count > 0 ? `Runners ${count} ●` : undefined;
}

export function formatRunnerFooterContribution(count: number): { fullText: string; compactText: string } | undefined {
  return count > 0 ? { fullText: `Runner ${count}`, compactText: `R${count}` } : undefined;
}

/** `api · 3m · nx dev-start api` — the widget's per-runner line. */
export function formatWidgetLine(record: RunnerRecord, now: number): string {
  const mode = record.interactive ? ' · tty' : '';
  return `${record.name} · ${formatUptime(record.startedAt, now)}${mode} · ${record.command}`;
}

export interface RunnerRow {
  name: string;
  detail: string;
  interactive: boolean;
}

/** Rows for the Runner Space list, as plain values so they can be asserted as text. */
export function toRunnerRows(records: readonly RunnerRecord[], now: number): RunnerRow[] {
  return records.map((record) => ({
    name: record.name,
    detail: `pid ${record.pid} · up ${formatUptime(record.startedAt, now)} · ${record.command}`,
    interactive: record.interactive,
  }));
}

/** Heading text for the widget, hidden entirely when there is nothing running. */
export function formatWidgetHeading(count: number): string {
  return `${OVERLAY_HEADING} (${count})`;
}
