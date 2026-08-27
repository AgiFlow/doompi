import type { FileEditEntry, FileEditVersion, LegacyTimelineEvent, TimelineEvent } from '../types/domain.ts';

/**
 * Fold a session's recorded changes into the per-file rows and version
 * histories the surfaces show.
 *
 * The timeline is append-only, one line per change, so every reader folds it
 * the same way and the folding belongs somewhere both the store and its tests
 * can reach without a filesystem. Version 1 lines are still read: a session
 * already running when the package updates keeps appending to the file it
 * opened, and dropping its earlier lines would blank a list mid-session.
 */

/** Either shape the timeline file can hold. */
export type AnyTimelineEvent = TimelineEvent | LegacyTimelineEvent;

const TOOLS = new Set(['edit', 'write', 'bash', 'user']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Narrows one parsed line, or answers null so a malformed line can be skipped. */
export function parseTimelineEvent(value: unknown): AnyTimelineEvent | null {
  if (!isRecord(value)) return null;
  const { version, path: filePath, tool, at } = value;
  if (typeof filePath !== 'string' || filePath === '') return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof tool !== 'string' || !TOOLS.has(tool)) return null;

  if (version === 1) {
    if (tool === 'user') return null; // The version 1 vocabulary had no manual saves.
    return { version: 1, path: filePath, tool: tool as LegacyTimelineEvent['tool'], at };
  }
  if (version !== 2) return null;
  const origin = value.origin === 'scan' ? 'scan' : 'tool';
  return {
    version: 2,
    path: filePath,
    tool: tool as TimelineEvent['tool'],
    at,
    origin,
    ...(optionalString(value.before) === undefined ? {} : { before: value.before as string }),
    ...(optionalString(value.after) === undefined ? {} : { after: value.after as string }),
    ...(optionalCount(value.additions) === undefined ? {} : { additions: value.additions as number }),
    ...(optionalCount(value.removals) === undefined ? {} : { removals: value.removals as number }),
  };
}

/** Every recorded line of the timeline, malformed ones dropped, in file order. */
export function parseTimeline(content: string, onMalformed?: (line: string) => void): AnyTimelineEvent[] {
  const events: AnyTimelineEvent[] = [];
  for (const line of content.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onMalformed?.(line);
      continue;
    }
    const event = parseTimelineEvent(parsed);
    if (event === null) onMalformed?.(line);
    else events.push(event);
  }
  return events;
}

/** One row per file, newest change first, which is the order both docks list in. */
export function foldEntries(events: readonly AnyTimelineEvent[]): FileEditEntry[] {
  const folded = new Map<string, FileEditEntry>();
  for (const event of events) {
    const current = folded.get(event.path);
    folded.set(event.path, {
      path: event.path,
      tool: event.at >= (current?.at ?? 0) ? event.tool : (current?.tool ?? event.tool),
      at: Math.max(event.at, current?.at ?? 0),
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...folded.values()].sort((left, right) => right.at - left.at);
}

/** One file's history, oldest first, numbered so a reader can name a version. */
export function foldVersions(events: readonly AnyTimelineEvent[], filePath: string): FileEditVersion[] {
  return events
    .filter((event) => event.path === filePath)
    .sort((left, right) => left.at - right.at)
    .map((event, offset) => {
      const version: FileEditVersion = {
        index: offset + 1,
        tool: event.tool,
        at: event.at,
        origin: event.version === 2 ? event.origin : 'scan',
      };
      if (event.version !== 2) return version;
      return {
        ...version,
        ...(event.before === undefined ? {} : { before: event.before }),
        ...(event.after === undefined ? {} : { after: event.after }),
        ...(event.additions === undefined ? {} : { additions: event.additions }),
        ...(event.removals === undefined ? {} : { removals: event.removals }),
      };
    });
}

/**
 * Whether a file can be diffed at all: some version has to have captured what
 * the file held before it changed. A file only ever seen after the fact, which
 * is every file a bash script wrote, never can be.
 */
export function isDiffable(versions: readonly FileEditVersion[]): boolean {
  return versions.some((version) => version.before !== undefined);
}

/** The oldest captured baseline for a file, which is what the whole-session diff starts from. */
export function baselineOf(versions: readonly FileEditVersion[]): string | undefined {
  return versions.find((version) => version.before !== undefined)?.before;
}
