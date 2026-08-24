import { stripAnsi } from './statusLine.ts';

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
 * The minor modes DoomPi ships, and the signal each one publishes.
 *
 * Help is listed without a signal on purpose: it registers no footer entry, so
 * the cockpit reports it as unavailable rather than guessing it is off.
 */
const MINOR_MODES: readonly MinorModeSource[] = [
  { name: 'help', keys: 'h e' },
  { name: 'plan', keys: 'p e', statusKey: 'plan-mode' },
  { name: 'loop', keys: 'l l', statusKey: 'doom-loop' },
  { name: 'goal', keys: 'g e', statusKey: 'goal' },
  { name: 'workflow', keys: 'w e', widgetKey: 'workflow-mcp-progress' },
  { name: 'voice', keys: 'v e', statusKey: 'doom-voice' },
];

export function minorModes(statuses: Record<string, string>, widgets: readonly string[]): MinorMode[] {
  return MINOR_MODES.map((source) => {
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

const ACTIVITY: readonly { name: string; keys: string; statusKey: string }[] = [
  { name: 'agents', keys: 'a r', statusKey: 'doom-team-agents' },
  { name: 'runners', keys: 'r l', statusKey: 'doom-runner-runners' },
];

export function activityGroups(statuses: Record<string, string>, widgets: readonly string[]): ActivityGroup[] {
  const groups = ACTIVITY.filter((entry) => statuses[entry.statusKey] !== undefined).map((entry) => {
    const summary = stripAnsi(statuses[entry.statusKey] ?? '').trim();
    return { name: entry.name, keys: entry.keys, summary, active: summary.length > 0 };
  });

  if (widgets.includes('workflow-mcp-progress') || widgets.includes('workflow-mcp-follow')) {
    groups.push({ name: 'workflows', keys: 'w r', summary: '', active: false });
  }
  return groups;
}
