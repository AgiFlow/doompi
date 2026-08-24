import type {
  ActivityGroupContribution,
  MinorModeContribution,
  PaletteCommandContribution,
  SelectionAxisContribution,
  SessionChannelContribution,
  SurfaceContribution,
  TabContribution,
  WebPluginDefinition,
  WebPluginRuntime,
} from '@agimon-ai/doompi-web-contracts';

export type SurfaceSlot = 'overlay' | 'rail' | 'selectionBar' | 'activity';

interface RegistryState {
  plugins: WebPluginDefinition[];
  tabs: TabContribution[];
  channels: Map<string, SessionChannelContribution>;
  surfaces: Record<SurfaceSlot, SurfaceContribution[]>;
  commands: PaletteCommandContribution[];
  selectionAxes: SelectionAxisContribution[];
  minorModes: MinorModeContribution[];
  activityGroups: ActivityGroupContribution[];
}

function emptyState(): RegistryState {
  return {
    plugins: [],
    tabs: [],
    channels: new Map(),
    surfaces: { overlay: [], rail: [], selectionBar: [], activity: [] },
    commands: [],
    selectionAxes: [],
    minorModes: [],
    activityGroups: [],
  };
}

/**
 * The installed plugin set. Plain module state rather than a reactive store:
 * the generated plugin list is installed once at startup, before the first
 * render, so every read during render is stable. resetWebPlugins exists for
 * unit tests only.
 */
let state = emptyState();
let installed = false;

export function installWebPlugins(plugins: readonly WebPluginDefinition[]): void {
  if (installed) throw new Error('Web plugins are already installed.');
  const seenPlugins = new Set<string>();
  for (const plugin of plugins) {
    if (seenPlugins.has(plugin.id)) throw new Error(`Duplicate web plugin id '${plugin.id}'.`);
    seenPlugins.add(plugin.id);
    state.plugins.push(plugin);
    for (const tab of plugin.tabs ?? []) {
      if (state.tabs.some((existing) => existing.id === tab.id)) {
        throw new Error(`Duplicate web plugin tab id '${tab.id}'.`);
      }
      state.tabs.push(tab);
    }
    for (const channel of plugin.channels ?? []) {
      if (state.channels.has(channel.channel)) {
        throw new Error(`Duplicate web plugin channel '${channel.channel}'.`);
      }
      state.channels.set(channel.channel, channel);
    }
    for (const surface of plugin.overlays ?? []) state.surfaces.overlay.push(surface);
    for (const surface of plugin.railSections ?? []) state.surfaces.rail.push(surface);
    for (const surface of plugin.selectionBarItems ?? []) state.surfaces.selectionBar.push(surface);
    for (const surface of plugin.activitySections ?? []) state.surfaces.activity.push(surface);
    state.commands.push(...(plugin.paletteCommands ?? []));
    state.selectionAxes.push(...(plugin.selectionAxes ?? []));
    state.minorModes.push(...(plugin.minorModes ?? []));
    state.activityGroups.push(...(plugin.activityGroups ?? []));
  }
  const byDisplayOrder = (left: { order?: number; name: string }, right: { order?: number; name: string }): number =>
    (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name);
  state.selectionAxes.sort(byDisplayOrder);
  state.minorModes.sort(byDisplayOrder);
  state.activityGroups.sort(byDisplayOrder);
  installed = true;
}

/** Unit-test escape hatch; production installs exactly once. */
export function resetWebPlugins(): void {
  state = emptyState();
  installed = false;
}

export function webTabs(): readonly TabContribution[] {
  return state.tabs;
}

export function surfaceContributions(slot: SurfaceSlot): readonly SurfaceContribution[] {
  return state.surfaces[slot];
}

export function paletteCommands(): readonly PaletteCommandContribution[] {
  return state.commands;
}

/** Selection-axis declarations from every installed plugin, in display order. */
export function pluginSelectionAxes(): readonly SelectionAxisContribution[] {
  return state.selectionAxes;
}

/** Minor-mode declarations from every installed plugin, in display order. */
export function pluginMinorModes(): readonly MinorModeContribution[] {
  return state.minorModes;
}

/** Activity-dock group declarations from every installed plugin, in display order. */
export function pluginActivityGroups(): readonly ActivityGroupContribution[] {
  return state.activityGroups;
}

/**
 * Routes one wire frame to the channel owning its type. Returns false when no
 * channel claims it, so the demux can fall through silently the way unknown
 * frames always have.
 */
export function dispatchChannelFrame(frame: Record<string, unknown>): boolean {
  if (typeof frame.type !== 'string' || typeof frame.sessionId !== 'string') return false;
  const channel = state.channels.get(frame.type);
  if (channel === undefined) return false;
  const payload = channel.parse(frame.payload);
  if (payload !== null) channel.apply(frame.sessionId, payload);
  return true;
}

/** Session teardown: every channel forgets the session's data. */
export function dropPluginSessionData(sessionId: string): void {
  for (const channel of state.channels.values()) channel.drop(sessionId);
}

/** Starts every plugin runtime in install order; the disposer runs in reverse. */
export function startWebPlugins(runtime: WebPluginRuntime): () => void {
  const disposers: Array<() => void> = [];
  for (const plugin of state.plugins) {
    const dispose = plugin.start?.(runtime);
    if (dispose) disposers.push(dispose);
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
