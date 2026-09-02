import type { StatusTone } from '@agimon-ai/doompi-web-components';
import type { TimelineEntry, ToolEntry } from './sessionModel.ts';

/**
 * Runs of the same tool, gathered so the transcript draws one frame instead of
 * five.
 *
 * An agent rarely calls a tool once: it reads four files, or runs five
 * commands, and each call arrives as its own entry. Rendered one card apiece
 * that reads as repetition rather than as progress, so adjacent calls of the
 * same tool are handed to the timeline as a single unit. Grouping is decided
 * here, on the entry list alone, so it can be tested without a browser and the
 * component stays a renderer.
 */

/** Two calls are the fewest that can read as a repetition, so a lone call keeps its card. */
const MIN_GROUP = 2;

export interface SingleUnit {
  readonly kind: 'single';
  readonly entry: TimelineEntry;
  /** The entry's index in the source list, for the timeline's live-tail window. */
  readonly index: number;
}

export interface GroupUnit {
  readonly kind: 'group';
  readonly name: string;
  readonly entries: readonly ToolEntry[];
  /** The index of the last entry in the run, so a group is skipped only once it is fully above the tail. */
  readonly index: number;
}

export type TimelineUnit = SingleUnit | GroupUnit;

function isTool(entry: TimelineEntry | undefined): entry is ToolEntry {
  return entry?.kind === 'tool';
}

/**
 * The entries as units to render.
 *
 * `groupable` decides which tool names may be gathered: a tool whose renderer
 * presents itself as a message, not a card, has no frame to share and stays on
 * its own. Only adjacent entries group, so anything between two calls, an
 * assistant reply or a notice, ends the run and keeps the transcript in order.
 */
export function timelineUnits(
  entries: readonly TimelineEntry[],
  groupable: (name: string) => boolean,
): readonly TimelineUnit[] {
  const units: TimelineUnit[] = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined) break;
    if (!isTool(entry) || !groupable(entry.name)) {
      units.push({ kind: 'single', entry, index });
      index += 1;
      continue;
    }
    const run: ToolEntry[] = [entry];
    let next = index + 1;
    while (next < entries.length) {
      const candidate = entries[next];
      if (!isTool(candidate) || candidate.name !== entry.name) break;
      run.push(candidate);
      next += 1;
    }
    if (run.length < MIN_GROUP) units.push({ kind: 'single', entry, index });
    else units.push({ kind: 'group', name: entry.name, entries: run, index: next - 1 });
    index = next;
  }
  return units;
}

/**
 * The group's own outcome: the worst thing in it. A run that is still going
 * reads as running, a run with a failure in it reads as failed, and only a run
 * where everything landed reads as ok.
 */
export function groupTone(entries: readonly ToolEntry[]): StatusTone {
  if (entries.some((entry) => entry.running)) return 'running';
  if (entries.some((entry) => entry.isError)) return 'error';
  return 'ok';
}

/** `5 calls`, the line beside the tool's name in the group header. */
export function groupSummary(entries: readonly ToolEntry[]): string {
  return `${String(entries.length)} call${entries.length === 1 ? '' : 's'}`;
}
