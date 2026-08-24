import type { SelectionAxisContribution } from '@agimon-ai/doompi-web-contracts';
import { pluginActivityGroups, pluginMinorModes, pluginSelectionAxes } from './pluginRegistry.ts';
import { stripAnsi } from './statusLine.ts';

export interface SelectionAxis {
  name: string;
  command: string;
  /** The current selection, empty while the session reports none. */
  value: string;
  emptyLabel: string;
}

/**
 * The fallback axis table for the packaged bundle; a synced bundle carries
 * each axis as its owning package's plugin declaration, and the registry
 * list wins whenever any plugin declares one.
 */
const FALLBACK_SELECTION_AXES: readonly SelectionAxisContribution[] = [
  { name: 'profile', command: 'profile', statusKey: 'doom-profile', emptyLabel: 'no profile' },
];

/**
 * The declared axes the session actually offers: an axis whose status key
 * the session never published stays off the bar entirely, which is how a
 * package withholds its axis when there is nothing to select.
 */
export function selectionAxes(statuses: Record<string, string>): SelectionAxis[] {
  const declared = pluginSelectionAxes();
  const sources: readonly SelectionAxisContribution[] = declared.length > 0 ? declared : FALLBACK_SELECTION_AXES;
  return sources.flatMap((source) => {
    const raw = statuses[source.statusKey];
    if (raw === undefined) return [];
    return [
      { name: source.name, command: source.command, value: stripAnsi(raw).trim(), emptyLabel: source.emptyLabel },
    ];
  });
}

export type MinorModeAvailability = 'unavailable' | 'off' | 'on';

export interface MinorMode {
  name: string;
  /** Leader Space key path, as the TUI documents it. */
  keys: string;
  availability: MinorModeAvailability;
  /** What the mode itself is reporting while on. */
  detail: string;
}

interface MinorModeSource {
  name: string;
  keys: string;
  statusKey?: string;
  widgetKey?: string;
}

/**
 * The fallback minor-mode table for the packaged bundle.
 *
 * A synced bundle carries each mode as its package's own web plugin
 * contribution, and the registry list wins whenever any plugin declares one.
 * This literal survives only so the built-in-only bundle keeps rendering the
 * modes DoomPi ships; help is listed without a signal on purpose: it
 * registers no footer entry, so the cockpit reports it as unavailable rather
 * than guessing it is off.
 */
const FALLBACK_MINOR_MODES: readonly MinorModeSource[] = [
  { name: 'help', keys: 'h e' },
  { name: 'plan', keys: 'p e', statusKey: 'plan-mode' },
  { name: 'loop', keys: 'l l', statusKey: 'doom-loop' },
  { name: 'goal', keys: 'g e', statusKey: 'goal' },
  { name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress' },
  { name: 'voice', keys: 'v e', statusKey: 'doom-voice' },
];

export function minorModes(statuses: Record<string, string>, widgets: readonly string[]): MinorMode[] {
  const declared = pluginMinorModes();
  const sources: readonly MinorModeSource[] = declared.length > 0 ? declared : FALLBACK_MINOR_MODES;
  return sources.map((source) => {
    if (source.statusKey !== undefined) {
      const raw = statuses[source.statusKey];
      if (raw === undefined)
        return { name: source.name, keys: source.keys, availability: 'unavailable' as const, detail: '' };
      const detail = stripAnsi(raw).trim();
      return {
        name: source.name,
        keys: source.keys,
        availability: detail ? ('on' as const) : ('off' as const),
        detail,
      };
    }
    if (source.widgetKey !== undefined && widgets.includes(source.widgetKey)) {
      return { name: source.name, keys: source.keys, availability: 'off' as const, detail: '' };
    }
    return { name: source.name, keys: source.keys, availability: 'unavailable' as const, detail: '' };
  });
}

export interface ActivityGroup {
  name: string;
  keys: string;
  /** What the publishing extension is reporting, empty when it reports nothing. */
  summary: string;
  active: boolean;
}

interface ActivityGroupSource {
  name: string;
  keys: string;
  statusKey?: string;
  widgetKeys?: string[];
}

/**
 * The fallback activity table for the packaged bundle; a synced bundle
 * carries each group as its owning package's plugin declaration, and the
 * registry list wins whenever any plugin declares one.
 */
const FALLBACK_ACTIVITY: readonly ActivityGroupSource[] = [
  { name: 'agents', keys: 'a r', statusKey: 'doom-team-agents' },
  { name: 'runners', keys: 'r l', statusKey: 'doom-runner-runners' },
  { name: 'workflows', keys: 'w r', widgetKeys: ['workflow-mcp-progress', 'workflow-mcp-follow'] },
];

export function activityGroups(statuses: Record<string, string>, widgets: readonly string[]): ActivityGroup[] {
  const declared = pluginActivityGroups();
  const sources: readonly ActivityGroupSource[] = declared.length > 0 ? declared : FALLBACK_ACTIVITY;
  const groups: ActivityGroup[] = [];
  for (const source of sources) {
    if (source.statusKey !== undefined && statuses[source.statusKey] !== undefined) {
      const summary = stripAnsi(statuses[source.statusKey] ?? '').trim();
      groups.push({ name: source.name, keys: source.keys, summary, active: summary.length > 0 });
      continue;
    }
    if (source.widgetKeys !== undefined && source.widgetKeys.some((key) => widgets.includes(key))) {
      groups.push({ name: source.name, keys: source.keys, summary: '', active: false });
    }
  }
  return groups;
}
