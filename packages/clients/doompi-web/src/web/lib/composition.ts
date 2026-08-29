import type { SelectionAxisContribution } from '@agimon-ai/doompi-web-contracts';
import type { MinorModeProjection, MinorModeRecordProjection } from '../../types/hub.ts';
import { pluginActivityGroups, pluginMinorModes, pluginSelectionAxes } from './pluginRegistry.ts';
import { stripAnsi } from './statusLine.ts';

export interface SelectionAxis {
  name: string;
  command: string;
  /** The current selections, empty while the session reports none; one at most unless multi. */
  values: string[];
  emptyLabel: string;
  multi: boolean;
}

const AXIS_LIST_SEPARATOR = ',';

/**
 * The fallback axis table for the packaged bundle; a synced bundle carries
 * each axis as its owning package's plugin declaration, and the registry
 * list wins whenever any plugin declares one. Exported only so the workspace
 * composition test can hold it equal to what the packages declare.
 */
export const PACKAGED_SELECTION_AXES: readonly SelectionAxisContribution[] = [
  { name: 'profile', command: 'profile', statusKey: 'doom-profile', emptyLabel: 'no profile', order: 10 },
  { name: 'domains', command: 'domains', statusKey: 'doom-domain', emptyLabel: 'no domains', multi: true, order: 20 },
];

/**
 * The declared axes the session actually offers: an axis whose status key
 * the session never published stays off the bar entirely, which is how a
 * package withholds its axis when there is nothing to select.
 */
export function selectionAxes(statuses: Record<string, string>): SelectionAxis[] {
  const declared = pluginSelectionAxes();
  const sources: readonly SelectionAxisContribution[] = declared.length > 0 ? declared : PACKAGED_SELECTION_AXES;
  return sources.flatMap((source) => {
    const raw = statuses[source.statusKey];
    if (raw === undefined) return [];
    const multi = source.multi === true;
    const values = (multi ? stripAnsi(raw).split(AXIS_LIST_SEPARATOR) : [stripAnsi(raw)])
      .map((value) => value.trim())
      .filter(Boolean);
    return [{ name: source.name, command: source.command, values, emptyLabel: source.emptyLabel, multi }];
  });
}

export type MinorModeAvailability = 'unavailable' | 'off' | 'on';

export interface MinorMode {
  name: string;
  /** The catalog id /minor accepts; the display name until the catalog reports. */
  id: string;
  /** Leader Space key path, as the TUI documents it. */
  keys: string;
  availability: MinorModeAvailability;
  /** What the mode itself is reporting while on. */
  detail: string;
  /**
   * Why the mode cannot be driven from here, in the words of the mode itself.
   * Empty when it can be. A mode may be installed and still refuse a cockpit:
   * autonomous voice captures from the terminal's own microphone, which a
   * browser talking to a headless agent does not have.
   */
  unavailableReason: string;
}

export interface MinorModeSource {
  name: string;
  /** The catalog mode this row drives, when the runtime registers it under another id. */
  modeId?: string;
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
 * than guessing it is off. Exported only for the workspace composition test.
 */
export const PACKAGED_MINOR_MODES: readonly MinorModeSource[] = [
  { name: 'help', keys: 'h e' },
  { name: 'plan', keys: 'p e', statusKey: 'plan-mode' },
  { name: 'loop', keys: 'l l', statusKey: 'doom-loop' },
  { name: 'goal', keys: 'g e', statusKey: 'goal' },
  { name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress' },
  // `v e` drives autonomous capture, which the runtime registers as 'voice-auto'.
  { name: 'voice', modeId: 'voice-auto', keys: 'v e', statusKey: 'doom-voice' },
];

/** The declared source a catalog mode corresponds to, by id, id stem, or label. */
function sourceFor(sources: readonly MinorModeSource[], mode: MinorModeRecordProjection): MinorModeSource | undefined {
  const candidates = new Set([mode.id.toLowerCase(), mode.id.toLowerCase().split('.')[0], mode.label.toLowerCase()]);
  return sources.find((source) =>
    [source.name, source.modeId].some((identity) => identity !== undefined && candidates.has(identity.toLowerCase())),
  );
}

/**
 * Catalog-backed rows: the runtime's own activation state per mode, with the
 * declared leader keys attached where a plugin documents them. Declared modes
 * the catalog does not know are still listed, as unavailable, so a mode that
 * is missing from a composition stays visible rather than silently gone.
 */
function catalogMinorModes(sources: readonly MinorModeSource[], projection: MinorModeProjection): MinorMode[] {
  const rows: MinorMode[] = projection.modes.map((mode) => {
    const source = sourceFor(sources, mode);
    const on = mode.activation === 'active' || mode.activation === 'deactivating';
    // The catalog says per action whether it can run here and why not. A mode
    // with nothing runnable is offered as a row that cannot be clicked rather
    // than one that answers "no actions available" after the fact.
    const blocked = mode.actions.length > 0 && mode.actions.every((action) => !action.enabled);
    const reason = blocked ? (mode.actions.find((action) => action.disabledReason)?.disabledReason ?? '') : '';
    return {
      name: source?.name ?? mode.label.toLowerCase(),
      id: mode.id,
      keys: source?.keys ?? '',
      availability: blocked && !on ? 'unavailable' : on ? 'on' : 'off',
      detail: mode.detail ?? (mode.activation === 'activating' ? 'activating' : ''),
      unavailableReason: reason,
    };
  });
  const seen = new Set(rows.map((row) => row.name));
  for (const source of sources) {
    if (!seen.has(source.name)) {
      rows.push({
        name: source.name,
        id: source.modeId ?? source.name,
        keys: source.keys,
        availability: 'unavailable',
        detail: '',
        unavailableReason: 'No package in this session registers this mode.',
      });
    }
  }
  return rows;
}

export function minorModes(
  statuses: Record<string, string>,
  widgets: readonly string[],
  projection: MinorModeProjection | null = null,
): MinorMode[] {
  const declared = pluginMinorModes();
  const sources: readonly MinorModeSource[] = declared.length > 0 ? declared : PACKAGED_MINOR_MODES;
  if (projection) return catalogMinorModes(sources, projection);
  return sources.map((source) => {
    if (source.statusKey !== undefined) {
      const raw = statuses[source.statusKey];
      if (raw === undefined) {
        return {
          name: source.name,
          id: source.modeId ?? source.name,
          keys: source.keys,
          availability: 'unavailable' as const,
          detail: '',
          unavailableReason: 'This session has not reported the mode.',
        };
      }
      const detail = stripAnsi(raw).trim();
      return {
        name: source.name,
        id: source.modeId ?? source.name,
        keys: source.keys,
        availability: detail ? ('on' as const) : ('off' as const),
        detail,
        unavailableReason: '',
      };
    }
    if (source.widgetKey !== undefined && widgets.includes(source.widgetKey)) {
      return {
        name: source.name,
        id: source.modeId ?? source.name,
        keys: source.keys,
        availability: 'off' as const,
        detail: '',
        unavailableReason: '',
      };
    }
    return {
      name: source.name,
      id: source.name,
      keys: source.keys,
      availability: 'unavailable' as const,
      detail: '',
      unavailableReason: 'This session has not reported the mode.',
    };
  });
}

export interface ActivityGroup {
  name: string;
  keys: string;
  /** What the publishing extension is reporting, empty when it reports nothing. */
  summary: string;
  active: boolean;
  /** The plugin tab the group's key chip opens, when its package declares one. */
  tab?: string;
  /** Keeps the group visible below the dock's scrolling ordinary groups. */
  placement?: 'bottom';
}

/**
 * The declared groups the session actually signals. There is no host-side
 * fallback table: agents, runners, and workflows are each declared by the
 * package that owns them, so a composition without such a package shows no
 * group, and a session that never published a group's signal shows none
 * either.
 *
 * A group that declared `hideWhenEmpty` also goes away again once its session
 * stops reporting. Clearing a status reaches the page as an empty string
 * rather than as an absent key, because the same map tells the selection bar
 * which minor modes exist and an absent key means "not reported" there. So
 * emptiness is read here instead, where only the dock is looking.
 */
export function activityGroups(statuses: Record<string, string>, widgets: readonly string[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const source of pluginActivityGroups()) {
    const tab = source.tab === undefined ? {} : { tab: source.tab };
    const placement = source.placement === undefined ? {} : { placement: source.placement };
    if (source.statusKey !== undefined && statuses[source.statusKey] !== undefined) {
      const summary = stripAnsi(statuses[source.statusKey] ?? '').trim();
      if (summary.length === 0 && source.hideWhenEmpty === true) continue;
      groups.push({ name: source.name, keys: source.keys, summary, active: summary.length > 0, ...tab, ...placement });
      continue;
    }
    if (source.widgetKeys !== undefined && source.widgetKeys.some((key) => widgets.includes(key))) {
      groups.push({ name: source.name, keys: source.keys, summary: '', active: false, ...tab, ...placement });
    }
  }
  return groups;
}
