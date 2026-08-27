import type {
  ActivityGroupContribution,
  LeaderBindingContribution,
  MinorModeContribution,
  PaletteCommandContribution,
  SettingsSectionContribution,
  SelectionAxisContribution,
  SessionChannelContribution,
  SlotDeclaration,
  SlotFillContribution,
  SurfaceContribution,
  TabContribution,
  ToolRendererContribution,
  WebPluginDefinition,
  WebPluginRuntime,
  WebPluginSlotProps,
} from '@agimon-ai/doompi-web-contracts';
import type { ComponentType } from 'react';
import { leaderConflicts } from './leaderTree.ts';

/**
 * The installed plugin set.
 *
 * Plain module state rather than a reactive store: the generated plugin list
 * is installed once at startup, before the first render, so every read during
 * render is stable. Install runs in two phases. The first collects every
 * plugin's contributions in the generated order, which is (registrationOrder,
 * pluginId); the second resolves every relation between plugins by name, so
 * a plugin may fill a slot whichever of the two installs first.
 *
 * Plugins are independent and a user may install any of them, so a collision
 * between two plugins never fails the install: a shared name goes to the
 * first plugin (a Leader Space leaf to the later one, as the TUI documents)
 * and the loser is recorded as a diagnostic. Only a malformed contribution
 * inside one plugin throws, because that is a developer error its own tests
 * catch. resetWebPlugins exists for unit tests only.
 */

export type InstallDiagnosticKind =
  | 'duplicate-plugin'
  | 'duplicate-tab'
  | 'duplicate-channel'
  | 'duplicate-tool'
  | 'duplicate-activity-group'
  | 'duplicate-minor-mode'
  | 'duplicate-selection-axis'
  | 'duplicate-palette-command'
  | 'duplicate-settings-section'
  | 'leader-leaf-override'
  | 'leader-group-label'
  | 'orphan-fill'
  | 'rejected-fill';

export interface InstallDiagnostic {
  /** The plugin that lost or misfiled the contribution. */
  pluginId: string;
  kind: InstallDiagnosticKind;
  message: string;
}

/** One placed fill, as the owner's renderSlot and slotData read it. */
export interface ResolvedFill {
  slot: string;
  pluginId: string;
  id: string;
  order: number;
  data?: unknown;
  component?: ComponentType<WebPluginSlotProps>;
}

/** The slots the host itself declares; a plugin's own slots are namespaced by its id instead. */
export const HOST_SLOTS = {
  overlay: 'overlay',
  rail: 'rail',
  selectionBar: 'selection-bar',
  activity: 'activity',
  composerActions: 'composer-actions',
} as const;

const SLOT_SEPARATOR = '.';
const DEFAULT_FILL_ORDER = 1000;
const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(Object.values(HOST_SLOTS));

/** The keyed slot an activity group opens: sections fill it and render as the group's body. */
export function activityGroupSlot(name: string): string {
  return `${HOST_SLOTS.activity}${SLOT_SEPARATOR}${name}`;
}

interface RegistryState {
  plugins: WebPluginDefinition[];
  tabs: TabContribution[];
  channels: Map<string, SessionChannelContribution>;
  commands: PaletteCommandContribution[];
  leaderBindings: LeaderBindingContribution[];
  selectionAxes: SelectionAxisContribution[];
  minorModes: MinorModeContribution[];
  activityGroups: ActivityGroupContribution[];
  settingsSections: SettingsSectionContribution[];
  toolRenderers: Map<string, ToolRendererContribution>;
  toolMatchers: ToolRendererContribution[];
  slots: Map<string, SlotDeclaration>;
  fills: Map<string, ResolvedFill[]>;
  diagnostics: InstallDiagnostic[];
}

function emptyState(): RegistryState {
  return {
    plugins: [],
    tabs: [],
    channels: new Map(),
    commands: [],
    leaderBindings: [],
    selectionAxes: [],
    minorModes: [],
    activityGroups: [],
    settingsSections: [],
    toolRenderers: new Map(),
    toolMatchers: [],
    slots: new Map(),
    fills: new Map(),
    diagnostics: [],
  };
}

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

interface PendingFill {
  pluginId: string;
  fill: SlotFillContribution;
}

interface PendingSection {
  pluginId: string;
  section: SurfaceContribution;
}

interface PendingBinding {
  pluginId: string;
  binding: LeaderBindingContribution;
}

type SharedNamespace =
  | 'plugin'
  | 'tab'
  | 'channel'
  | 'tool'
  | 'activity-group'
  | 'minor-mode'
  | 'selection-axis'
  | 'palette-command'
  | 'settings-section';

/**
 * Claims `id` in one shared namespace: false, with a diagnostic, when another
 * plugin already holds it; a throw when this plugin declared it twice, which
 * is a developer error rather than a composition.
 */
function claim(owners: Map<string, string>, thing: SharedNamespace, id: string, pluginId: string): boolean {
  const holder = owners.get(id);
  if (holder === pluginId) {
    throw new Error(`Web plugin '${pluginId}' declares ${thing.replace('-', ' ')} '${id}' twice.`);
  }
  if (holder !== undefined) {
    state.diagnostics.push({
      pluginId,
      kind: `duplicate-${thing}`,
      message: `Web plugin '${pluginId}' ${thing.replace('-', ' ')} '${id}' is already provided by '${holder}'; keeping the first.`,
    });
    return false;
  }
  owners.set(id, pluginId);
  return true;
}

function surfaceFill(slot: string, surface: SurfaceContribution): SlotFillContribution {
  return { slot, id: surface.id, component: surface.component };
}

function checkSlotDeclaration(pluginId: string, declared: Set<string>, declaration: SlotDeclaration): void {
  const prefix = `${pluginId}${SLOT_SEPARATOR}`;
  if (!declaration.slot.startsWith(prefix) || declaration.slot.length === prefix.length) {
    throw new Error(
      `Web plugin '${pluginId}' declares slot '${declaration.slot}', which must be named '${prefix}<name>'.`,
    );
  }
  if (declared.has(declaration.slot)) {
    throw new Error(`Web plugin '${pluginId}' declares slot '${declaration.slot}' twice.`);
  }
  declared.add(declaration.slot);
}

function checkFill(pluginId: string, seen: Set<string>, fill: SlotFillContribution): void {
  if (fill.id === '') throw new Error(`Web plugin '${pluginId}' has a fill into '${fill.slot}' with an empty id.`);
  if (fill.component === undefined && fill.data === undefined) {
    throw new Error(`Web plugin '${pluginId}' fill '${fill.id}' into '${fill.slot}' has neither a component nor data.`);
  }
  const key = `${fill.slot} ${fill.id}`;
  if (seen.has(key)) throw new Error(`Web plugin '${pluginId}' fills '${fill.slot}' with id '${fill.id}' twice.`);
  seen.add(key);
}

const byFillOrder = (left: ResolvedFill, right: ResolvedFill): number =>
  left.order - right.order || left.pluginId.localeCompare(right.pluginId) || left.id.localeCompare(right.id);

const byDisplayOrder = (left: { order?: number; name: string }, right: { order?: number; name: string }): number =>
  (left.order ?? DEFAULT_FILL_ORDER) - (right.order ?? DEFAULT_FILL_ORDER) || left.name.localeCompare(right.name);

function placeFill(pluginId: string, fill: SlotFillContribution): void {
  const declaration = state.slots.get(fill.slot);
  if (declaration === undefined) {
    state.diagnostics.push({
      pluginId,
      kind: 'orphan-fill',
      message: `Web plugin '${pluginId}' fills slot '${fill.slot}', which no installed plugin declares; nothing is placed.`,
    });
    return;
  }
  let data = fill.data;
  if (data !== undefined && declaration.parse !== undefined) {
    const parsed = declaration.parse(data);
    if (parsed === null) {
      state.diagnostics.push({
        pluginId,
        kind: 'rejected-fill',
        message: `Web plugin '${pluginId}' fill '${fill.id}' into '${fill.slot}' was rejected by the slot's parse gate.`,
      });
      return;
    }
    data = parsed;
  }
  const placed: ResolvedFill = {
    slot: fill.slot,
    pluginId,
    id: fill.id,
    order: fill.order ?? DEFAULT_FILL_ORDER,
    ...(data === undefined ? {} : { data }),
    ...(fill.component === undefined ? {} : { component: fill.component }),
  };
  const list = state.fills.get(fill.slot);
  if (list === undefined) state.fills.set(fill.slot, [placed]);
  else list.push(placed);
}

function resolveLeaderConflicts(bindings: readonly PendingBinding[]): void {
  const owner = new Map<LeaderBindingContribution, string>(bindings.map((entry) => [entry.binding, entry.pluginId]));
  for (const conflict of leaderConflicts(bindings.map((entry) => entry.binding))) {
    const winner = owner.get(conflict.winner) ?? '';
    const loser = owner.get(conflict.loser) ?? '';
    if (winner === loser) {
      throw new Error(
        `Web plugin '${winner}' binds Leader Space '${conflict.path}' twice ('${conflict.loser.id}' and '${conflict.winner.id}').`,
      );
    }
    if (conflict.kind === 'leaf-override') {
      state.diagnostics.push({
        pluginId: loser,
        kind: 'leader-leaf-override',
        message: `Web plugin '${loser}' Leader Space leaf '${conflict.path}' ('${conflict.loser.id}') is taken over by '${winner}' ('${conflict.winner.id}').`,
      });
    } else {
      state.diagnostics.push({
        pluginId: loser,
        kind: 'leader-group-label',
        message: `Web plugin '${loser}' words Leader Space group '${conflict.path}' differently from '${winner}', which named it first; keeping the first label.`,
      });
    }
  }
}

export function installWebPlugins(plugins: readonly WebPluginDefinition[]): void {
  if (installed) throw new Error('Web plugins are already installed.');
  const owners: Record<SharedNamespace, Map<string, string>> = {
    plugin: new Map(),
    tab: new Map(),
    channel: new Map(),
    tool: new Map(),
    'activity-group': new Map(),
    'minor-mode': new Map(),
    'selection-axis': new Map(),
    'palette-command': new Map(),
    'settings-section': new Map(),
  };
  const pendingFills: PendingFill[] = [];
  const pendingSections: PendingSection[] = [];
  const pendingBindings: PendingBinding[] = [];
  const pendingSlots: SlotDeclaration[] = [];

  // Phase 1: collect, in the generated (registrationOrder, pluginId) order.
  for (const plugin of plugins) {
    if (RESERVED_PLUGIN_IDS.has(plugin.id)) {
      throw new Error(`Web plugin id '${plugin.id}' is reserved for a host slot.`);
    }
    if (owners.plugin.has(plugin.id)) {
      state.diagnostics.push({
        pluginId: plugin.id,
        kind: 'duplicate-plugin',
        message: `Web plugin id '${plugin.id}' is declared twice; keeping the first definition.`,
      });
      continue;
    }
    owners.plugin.set(plugin.id, plugin.id);
    state.plugins.push(plugin);
    for (const tab of plugin.tabs ?? []) {
      if (claim(owners.tab, 'tab', tab.id, plugin.id)) state.tabs.push(tab);
    }
    for (const section of plugin.settingsSections ?? []) {
      if (claim(owners['settings-section'], 'settings-section', section.id, plugin.id)) {
        state.settingsSections.push(section);
      }
    }
    for (const channel of plugin.channels ?? []) {
      if (claim(owners.channel, 'channel', channel.channel, plugin.id)) state.channels.set(channel.channel, channel);
    }
    for (const command of plugin.paletteCommands ?? []) {
      if (claim(owners['palette-command'], 'palette-command', command.id, plugin.id)) state.commands.push(command);
    }
    for (const binding of plugin.leaderBindings ?? []) {
      checkLeaderBinding(plugin.id, binding);
      pendingBindings.push({ pluginId: plugin.id, binding });
    }
    for (const axis of plugin.selectionAxes ?? []) {
      if (claim(owners['selection-axis'], 'selection-axis', axis.name, plugin.id)) state.selectionAxes.push(axis);
    }
    for (const mode of plugin.minorModes ?? []) {
      if (claim(owners['minor-mode'], 'minor-mode', mode.name, plugin.id)) state.minorModes.push(mode);
    }
    for (const group of plugin.activityGroups ?? []) {
      if (claim(owners['activity-group'], 'activity-group', group.name, plugin.id)) state.activityGroups.push(group);
    }
    for (const renderer of plugin.toolRenderers ?? []) {
      for (const tool of renderer.tools) {
        if (claim(owners.tool, 'tool', tool, plugin.id)) state.toolRenderers.set(tool, renderer);
      }
      if (renderer.matches !== undefined) state.toolMatchers.push(renderer);
    }
    const declared = new Set<string>();
    for (const declaration of plugin.slots ?? []) {
      checkSlotDeclaration(plugin.id, declared, declaration);
      pendingSlots.push(declaration);
    }
    const filled = new Set<string>();
    for (const fill of plugin.fills ?? []) {
      checkFill(plugin.id, filled, fill);
      pendingFills.push({ pluginId: plugin.id, fill });
    }
    for (const surface of plugin.overlays ?? []) {
      pendingFills.push({ pluginId: plugin.id, fill: surfaceFill(HOST_SLOTS.overlay, surface) });
    }
    for (const surface of plugin.railSections ?? []) {
      pendingFills.push({ pluginId: plugin.id, fill: surfaceFill(HOST_SLOTS.rail, surface) });
    }
    for (const surface of plugin.selectionBarItems ?? []) {
      pendingFills.push({ pluginId: plugin.id, fill: surfaceFill(HOST_SLOTS.selectionBar, surface) });
    }
    for (const surface of plugin.composerActions ?? []) {
      pendingFills.push({ pluginId: plugin.id, fill: surfaceFill(HOST_SLOTS.composerActions, surface) });
    }
    for (const section of plugin.activitySections ?? []) pendingSections.push({ pluginId: plugin.id, section });
  }

  // Phase 2: resolve by name, now that every declaration is known.
  for (const slot of Object.values(HOST_SLOTS)) state.slots.set(slot, { slot });
  for (const group of state.activityGroups) {
    state.slots.set(activityGroupSlot(group.name), { slot: activityGroupSlot(group.name) });
  }
  for (const declaration of pendingSlots) state.slots.set(declaration.slot, declaration);
  for (const { pluginId, section } of pendingSections) {
    const keyed = activityGroupSlot(section.id);
    pendingFills.push({ pluginId, fill: surfaceFill(state.slots.has(keyed) ? keyed : HOST_SLOTS.activity, section) });
  }
  for (const { pluginId, fill } of pendingFills) placeFill(pluginId, fill);
  for (const list of state.fills.values()) list.sort(byFillOrder);

  resolveLeaderConflicts(pendingBindings);
  state.leaderBindings.push(...pendingBindings.map((entry) => entry.binding));
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

/** What the install had to resolve between plugins; empty for a composition whose plugins never collide. */
export function webPluginDiagnostics(): readonly InstallDiagnostic[] {
  return state.diagnostics;
}

/** Every installed plugin definition, in install order; the settings page lists them. */
export function installedWebPlugins(): readonly WebPluginDefinition[] {
  return state.plugins;
}

export function webTabs(): readonly TabContribution[] {
  return state.tabs;
}

/**
 * The settings pages plugins contribute, in menu order. Sorted here rather than
 * at the reader so the menu and the page agree without either sorting twice.
 */
export function pluginSettingsSections(): readonly SettingsSectionContribution[] {
  return state.settingsSections;
}

/** The fills placed into one slot, in slot order; empty for a slot nobody declared. */
export function slotFills(slot: string): readonly ResolvedFill[] {
  return state.fills.get(slot) ?? [];
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
 * then the first runtime matcher that accepts it, in install order (the one
 * place besides `start` where that order is observable); undefined leaves
 * the host's default card.
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
