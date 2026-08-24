import type {
  ActivityGroupContribution,
  LeaderBindingContribution,
  MinorModeContribution,
  PaletteCommandContribution,
  SelectionAxisContribution,
  SessionChannelContribution,
  SurfaceContribution,
  TabContribution,
  ToolRendererContribution,
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
  leaderBindings: LeaderBindingContribution[];
  selectionAxes: SelectionAxisContribution[];
  minorModes: MinorModeContribution[];
  activityGroups: ActivityGroupContribution[];
  toolRenderers: Map<string, ToolRendererContribution>;
  toolMatchers: ToolRendererContribution[];
}

function emptyState(): RegistryState {
  return {
    plugins: [],
    tabs: [],
    channels: new Map(),
    surfaces: { overlay: [], rail: [], selectionBar: [], activity: [] },
    commands: [],
    leaderBindings: [],
    selectionAxes: [],
    minorModes: [],
    activityGroups: [],
    toolRenderers: new Map(),
    toolMatchers: [],
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

/** The TUI's leader alphabet: one lowercase letter or digit per segment. */
const LEADER_KEY = /^[a-z0-9]$/;
const MAX_LEADER_PATH = 4;

/**
 * A malformed binding fails the install rather than the keypress: the plugin
 * set is generated at build time, so this is a developer error, and the TUI's
 * registry refuses the same shapes.
 */
function checkLeaderBinding(pluginId: string, binding: LeaderBindingContribution): void {
  if (binding.path.length === 0 || binding.path.length > MAX_LEADER_PATH) {
    throw new Error(
      `Web plugin '${pluginId}' leader binding '${binding.id}' needs 1 to ${MAX_LEADER_PATH} path segments.`,
    );
  }
  for (const segment of binding.path) {
    if (!LEADER_KEY.test(segment.key)) {
      throw new Error(
        `Web plugin '${pluginId}' leader binding '${binding.id}' key '${segment.key}' must be one lowercase letter or digit.`,
      );
    }
    if (segment.label.trim() === '') {
      throw new Error(`Web plugin '${pluginId}' leader binding '${binding.id}' has an unlabeled segment.`);
    }
  }
}

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
    for (const binding of plugin.leaderBindings ?? []) {
      checkLeaderBinding(plugin.id, binding);
      state.leaderBindings.push(binding);
    }
    state.selectionAxes.push(...(plugin.selectionAxes ?? []));
    state.minorModes.push(...(plugin.minorModes ?? []));
    state.activityGroups.push(...(plugin.activityGroups ?? []));
    for (const renderer of plugin.toolRenderers ?? []) {
      for (const tool of renderer.tools) {
        if (state.toolRenderers.has(tool)) {
          throw new Error(`Web plugin '${plugin.id}' claims tool '${tool}', which another plugin already renders.`);
        }
        state.toolRenderers.set(tool, renderer);
      }
      if (renderer.matches !== undefined) state.toolMatchers.push(renderer);
    }
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

/** Leader Space bindings from every installed plugin, in install order: a later binding on a bound leaf wins. */
export function pluginLeaderBindings(): readonly LeaderBindingContribution[] {
  return state.leaderBindings;
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
 * The renderer a plugin registered for one tool: the exact name claim first,
 * then the first runtime matcher that accepts it; undefined leaves the host's
 * default card.
 */
export function pluginToolRenderer(
  toolName: string,
  statuses: Readonly<Record<string, string>> = {},
): ToolRendererContribution | undefined {
  return (
    state.toolRenderers.get(toolName) ?? state.toolMatchers.find((renderer) => renderer.matches?.(toolName, statuses))
  );
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
