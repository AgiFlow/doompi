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
  minorModes?: MinorModeContribution[];
  overlays?: SurfaceContribution[];
  paletteCommands?: PaletteCommandContribution[];
  railSections?: SurfaceContribution[];
  selectionBarItems?: SurfaceContribution[];
  activitySections?: SurfaceContribution[];
  /** Started after the host runtime; the return value disposes. */
  start?(runtime: WebPluginRuntime): (() => void) | void;
}
