import type { ComponentType } from 'react';

/**
 * The client half of the DoomPi web plugin contract.
 *
 * A plugin package exports one `webPlugin: WebPluginDefinition` from its
 * declared client entry. The cockpit's bundler compiles that entry into the
 * host bundle, so a plugin's client code may import only react, @tanstack
 * store packages, this contract, and the plugin package's own pure modules;
 * never node builtins or server frameworks, which the host bundle would
 * swallow. Tailwind utility classes must appear as complete literal strings
 * so the host's class scanner can see them.
 */

/** Every slot component receives the focused session; null while nothing is focused. */
export interface WebPluginSlotProps {
  sessionId: string | null;
  /** Host navigation for the focused session; null returns to the conversation tab. */
  openTab: (tabId: string | null) => void;
}

export interface TabContribution {
  /** URL segment (/session/:id/:tabId) and testid suffix (tab-<id>, tab-<id>-count). */
  id: string;
  label: string;
  panel: ComponentType<WebPluginSlotProps>;
  /** A React hook, fully typed inside the plugin; 0 hides the badge. */
  useBadge?: (sessionId: string | null) => number;
}

export interface SurfaceContribution {
  id: string;
  component: ComponentType<WebPluginSlotProps>;
}

export interface PaletteCommandContext {
  sessionId: string | null;
  /** Host navigation; null returns to the conversation tab. */
  openTab(tabId: string | null): void;
  sendSessionFrame(sessionId: string, frame: Record<string, unknown>): void;
}

export interface PaletteCommandContribution {
  id: string;
  title: string;
  description?: string;
  run(context: PaletteCommandContext): void;
}

/**
 * A minor mode's presence in the cockpit, declared as data rather than a
 * component: the host's selection bar renders the list, folding in what the
 * session reports. A mode with neither signal key shows as unavailable until
 * its package publishes one.
 */
export interface MinorModeContribution {
  name: string;
  /** Leader Space key path, as the TUI documents it. */
  keys: string;
  /** Footer status key whose presence and content report availability and detail. */
  statusKey?: string;
  /** Widget key whose presence reports the mode as installed but off. */
  widgetKey?: string;
  /** Sort position in the selection bar list; lower first, name breaks ties. */
  order?: number;
}

/**
 * A selection-bar axis, declared as data: the host renders the chip and
 * routes its click through the axis's slash command. The axis shows only
 * while the session publishes the status key; the content is the current
 * selection, and emptyLabel shows while it is published empty.
 */
export interface SelectionAxisContribution {
  /** Chip identity: testid axis-<name> and the popover menu it claims. */
  name: string;
  /** Slash command the host runs when the chip is clicked. */
  command: string;
  /** Footer status key: absent hides the axis, content is the selection. */
  statusKey: string;
  /** Shown while the status is published with nothing selected. */
  emptyLabel: string;
  /** The status content is a comma-separated list: several selections can be active at once. */
  multi?: boolean;
  /** Sort position in the bar; lower first, name breaks ties. */
  order?: number;
}

/**
 * An activity-dock group, declared as data: the host renders the group's
 * frame when the session publishes its signal (the footer status key, or any
 * of the widget keys). The body is the status content as a one-line summary
 * unless the plugin claims the group with an activity section of the same
 * name, in which case the plugin renders the body itself.
 */
export interface ActivityGroupContribution {
  name: string;
  /** Leader Space key path, as the TUI documents it. */
  keys: string;
  /** Footer status key whose presence shows the group and content fills its summary. */
  statusKey?: string;
  /** Widget keys any of which shows the group without a summary. */
  widgetKeys?: string[];
  /** The plugin tab the group's key chip opens; without one the chip is a plain label. */
  tab?: string;
  /** Sort position in the dock; lower first, name breaks ties. */
  order?: number;
}

/**
 * One session-scoped data channel: the hub pushes ChannelFrame payloads whose
 * frame type equals `channel`; parse is the validation gate at the boundary
 * (null rejects); drop clears the plugin's per-session state.
 */
export interface SessionChannelContribution<Payload = unknown> {
  channel: string;
  parse(input: unknown): Payload | null;
  apply(sessionId: string, payload: Payload): void;
  drop(sessionId: string): void;
}

/** What a plugin's optional runtime may do; both send on the page's hub socket. */
export interface WebPluginRuntime {
  sendSessionFrame(sessionId: string, frame: Record<string, unknown>): void;
  sendHubFrame(frame: Record<string, unknown>): void;
}

export interface WebPluginDefinition {
  id: string;
  tabs?: TabContribution[];
  channels?: SessionChannelContribution[];
  selectionAxes?: SelectionAxisContribution[];
  minorModes?: MinorModeContribution[];
  activityGroups?: ActivityGroupContribution[];
  overlays?: SurfaceContribution[];
  paletteCommands?: PaletteCommandContribution[];
  railSections?: SurfaceContribution[];
  selectionBarItems?: SurfaceContribution[];
  /**
   * A section whose id equals one of the plugin's activity group names renders
   * inside that group, replacing the session's one-line summary with the
   * plugin's own detail; any other section renders after the groups.
   */
  activitySections?: SurfaceContribution[];
  /** Started after the host runtime; the return value disposes. */
  start?(runtime: WebPluginRuntime): (() => void) | void;
}
