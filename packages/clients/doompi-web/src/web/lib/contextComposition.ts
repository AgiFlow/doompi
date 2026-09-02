import type { MinorModeProjection } from '../../types/hub.ts';
import { minorModes } from './composition.ts';
import { parseSelection } from './statusLine.ts';

/**
 * What the session is composed of, as opposed to what it is doing.
 *
 * The activity dock answers "what is running"; this answers "what is loaded and
 * what does carrying it cost". A group is a mode, because a mode is the thing a
 * reader can actually switch off: grouping by source would name the mechanism
 * rather than the decision. Rows inside a group are ordered by source kind so
 * the session's own extensions read before anything a server or plugin added.
 */
export type ContextGroupKind = 'major' | 'minor' | 'domain' | 'core';

export type ContextItemSource = 'extension' | 'mcp' | 'plugin' | 'core';

/** Extensions first: they are the session's own, and the eye starts there. */
const SOURCE_ORDER: Record<ContextItemSource, number> = { extension: 0, mcp: 1, plugin: 2, core: 3 };

const KIND_ORDER: Record<ContextGroupKind, number> = { major: 0, minor: 1, domain: 2, core: 3 };

export interface ContextItem {
  name: string;
  itemKind: 'tool' | 'skill';
  source: ContextItemSource;
  /** The package or server that registered it. */
  owner: string;
  /** Estimated tokens, or null while the runtime has not reported a figure. */
  tokens: number | null;
  active: boolean;
}

export interface ContextGroup {
  id: string;
  label: string;
  kind: ContextGroupKind;
  /** A short qualifier shown beside the label, e.g. a pending switch. */
  detail: string;
  items: ContextItem[];
  /** Subtotal across `items`, or null when no item carries a figure. */
  tokens: number | null;
}

function bySource(left: ContextItem, right: ContextItem): number {
  return SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || left.name.localeCompare(right.name);
}

/** A group with nothing priced reports null rather than a confident zero. */
function subtotal(items: readonly ContextItem[]): number | null {
  const priced = items.filter((item) => item.tokens !== null);
  return priced.length === 0 ? null : priced.reduce((total, item) => total + (item.tokens ?? 0), 0);
}

function group(id: string, label: string, kind: ContextGroupKind, detail: string, items: ContextItem[]): ContextGroup {
  const sorted = [...items].sort(bySource);
  return { id, label, kind, detail, items: sorted, tokens: subtotal(sorted) };
}

/**
 * The composition the session is running under.
 *
 * Until the runtime publishes its inventory every group is empty, which is the
 * honest reading: the modes are known from the footer the session already
 * publishes, the tools they brought are not.
 */
export function contextGroups(
  statuses: Record<string, string>,
  widgets: readonly string[],
  projection: MinorModeProjection | null = null,
  items: readonly ContextItem[] = [],
  attribution: Readonly<Record<string, string>> = {},
): ContextGroup[] {
  const selection = parseSelection(statuses['doom-major-mode'] ?? '');
  const byGroup = new Map<string, ContextItem[]>();
  for (const item of items) {
    const key = attribution[item.name] ?? 'core';
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(item);
    else byGroup.set(key, [item]);
  }
  const take = (key: string): ContextItem[] => byGroup.get(key) ?? [];

  const groups: ContextGroup[] = [];

  if (selection.majorMode) {
    groups.push(
      group(
        selection.majorMode,
        selection.majorMode,
        'major',
        selection.pending ? 'switching' : '',
        take(selection.majorMode),
      ),
    );
  }

  for (const mode of minorModes(statuses, widgets, projection)) {
    if (mode.availability !== 'on') continue;
    groups.push(group(mode.id, mode.name, 'minor', mode.detail, take(mode.id)));
  }

  for (const domain of [...selection.domains].sort((left, right) => left.localeCompare(right))) {
    groups.push(group(domain, domain, 'domain', '', take(domain)));
  }

  // Pi's own tools, and anything the runtime could not attribute. An
  // unattributed tool is still costing context, so it is listed rather than
  // dropped for failing to name a sponsor.
  const orphans = take('core');
  if (orphans.length > 0) groups.push(group('core', 'core', 'core', '', orphans));

  return groups.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
}

/** The whole composition's estimate, or null while nothing is priced. */
export function totalTokens(groups: readonly ContextGroup[]): number | null {
  const priced = groups.filter((entry) => entry.tokens !== null);
  return priced.length === 0 ? null : priced.reduce((total, entry) => total + (entry.tokens ?? 0), 0);
}
