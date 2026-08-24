import type { Store } from '@tanstack/store';
import type { ComponentType, ReactNode } from 'react';

/**
 * The client half of the DoomPi web plugin contract.
 *
 * A plugin package exports one `webPlugin: WebPluginDefinition` from its
 * declared client entry. The cockpit's bundler compiles that entry into the
 * host bundle, so a plugin's client code may import only react,
 * @tanstack/store, @tanstack/react-store, this contract,
 * @agimon-ai/doompi-web-components, and the package's own web/ and src/types
 * modules; never another plugin, a node builtin, or a server framework, which
 * the host bundle would swallow. Per-session state takes the shape
 * defineSessionStore gives it. Tailwind utility classes must appear as
 * complete literal strings so the host's class scanner can see them.
 *
 * Plugins are independent: none depends on another, any of them may be added
 * or removed at the next sync, and every relation between two plugins (a fill
 * into a slot, a section inside an activity group) resolves by name once every
 * plugin is installed. The manifest's registrationOrder is only a tiebreak,
 * and a collision between two plugins is an install diagnostic, never a
 * failure.
 */
/** Sends one command frame to a session's agent on the page's hub socket. */
export type SessionFrameSender = (sessionId: string, frame: Record<string, unknown>) => void;
/**
 * A slot a plugin opens inside its own UI for independent plugins to fill.
 * The name is namespaced by its owner, '<pluginId>.<name>', so no two plugins
 * open the same slot. A slot with a parse gate takes data fills, declared as
 * data the owner renders; one without takes component fills the owner places
 * with renderSlot. Either side may be absent: the owner renders with zero
 * fills, and a fill into a slot no installed plugin declares is an install
 * diagnostic, never a failure.
 */
export interface SlotDeclaration<Data = unknown> {
  slot: string;
  /** The gate for data fills, run once at install; null rejects the fill with a diagnostic. */
  parse?(input: unknown): Data | null;
}
/** A data fill as its owner reads it back, already through the parse gate. */
export interface SlotDataFill<Data = unknown> {
  pluginId: string;
  id: string;
  order: number;
  data: Data;
}
/** Every slot component receives the focused session; null while nothing is focused. */
export interface WebPluginSlotProps {
  sessionId: string | null;
  /** Host navigation for the focused session; null returns to the conversation tab. */
  openTab: (tabId: string | null) => void;
  /** The same sender palette commands and `start` receive; components act through it. */
  sendSessionFrame: SessionFrameSender;
  /** The component fills of one slot, in slot order; the host resolves them, so this contract holds no state. */
  renderSlot: (slot: string) => ReactNode;
  /** The data fills of one slot, typed by the declaration handle only its owner holds. */
  slotData: <Data>(slot: SlotDeclaration<Data>) => readonly SlotDataFill<Data>[];
}
/**
 * One contribution into a slot, keyed by (pluginId, id): independent plugins
 * never collide on an id. A component fill renders where the owner places the
 * slot; a data fill is what the owner's parse gate reads.
 */
export interface SlotFillContribution {
  slot: string;
  id: string;
  /** Sort position within the slot; lower first, then pluginId, then id. */
  order?: number;
  data?: unknown;
  component?: ComponentType<WebPluginSlotProps>;
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
  sendSessionFrame: SessionFrameSender;
}
export interface PaletteCommandContribution {
  id: string;
  title: string;
  description?: string;
  run(context: PaletteCommandContext): void;
}
/**
 * One step of a Leader Space key path: the key pressed and the label the
 * menu shows beside it. Keys are one lowercase letter or digit, the same
 * alphabet the TUI's leader registry accepts.
 */
export interface LeaderKeyContribution {
  key: string;
  label: string;
  detail?: string;
}
export interface LeaderBindingBase {
  id: string;
  /** The SPC path, group segments first; the last segment is the key that fires. */
  path: LeaderKeyContribution[];
}
/**
 * A Leader Space binding, the cockpit's half of the TUI's leader contract.
 *
 * The session's own leader tree never reaches an RPC client, so each package
 * declares here the paths its TUI documents that a browser can honor: a slash
 * command line the host sends through the prompt channel (without the leading
 * slash), or a client action such as opening the plugin's tab. Plugins that
 * share a group prefix (SPC w) word it the same way; the first to register a
 * segment names it, and a later binding on an already-bound leaf takes it
 * over. Either disagreement between two plugins is an install diagnostic.
 */
export type LeaderBindingContribution =
  | (LeaderBindingBase & {
      command: string;
    })
  | (LeaderBindingBase & {
      run(context: PaletteCommandContext): void;
    });
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
 * unless some plugin fills the group's slot, `activity.<name>`, with an
 * activity section of the same name, in which case those sections render the
 * body themselves.
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
/** One record per session id; a missing key means the session has reported nothing. */
export type SessionRecords<T> = Partial<Record<string, T>>;
/** A channel folded straight into a session store: parse gates the wire, reduce folds one payload into the record. */
export interface SessionStoreChannel<T, Payload> {
  channel: string;
  parse(input: unknown): Payload | null;
  /** Folds one payload into the session's record; ephemeral fields (stop requests, dismissals) reconcile here. */
  reduce(current: T, payload: Payload): T;
}
/**
 * Per-session plugin state, the shape every plugin's store takes: one record
 * per session, shared by the plugin's tab, badge, sections, and channels.
 * Records are immutable values; updaters and reducers return new ones.
 */
export interface SessionStore<T> {
  readonly store: Store<SessionRecords<T>>;
  /**
   * The session's record, or the one shared empty record for null and unknown
   * sessions: a stable reference, so a useStore selector over it never
   * re-renders on an unchanged session.
   */
  select(state: SessionRecords<T>, sessionId: string | null): T;
  /** Replaces the session's record; an updater returning the current record publishes nothing. */
  update(sessionId: string, updater: (current: T) => T): void;
  drop(sessionId: string): void;
  reset(): void;
  /** A session channel whose apply and drop are already wired to this store. */
  channel<Payload>(options: SessionStoreChannel<T, Payload>): SessionChannelContribution;
}
/**
 * A tool result as Pi's tool_execution frames carry it: the content blocks
 * the model sees and the structured `details` the tool attached for its own
 * renderer. Both are wire JSON; the plugin that owns the tool narrows them.
 */
export interface ToolResultView {
  content: unknown[];
  details: unknown;
}
/** The call half of a tool card, the cockpit's analog of the TUI's renderCall arguments. */
export interface ToolCallRenderProps {
  sessionId: string | null;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** The session's footer statuses at render time, the same picture `matches` saw. */
  statuses: Readonly<Record<string, string>>;
}
/** The result half, the analog of the TUI's renderResult arguments and options. */
export interface ToolResultRenderProps extends ToolCallRenderProps {
  /** The newest result: partial while the tool runs, final once it ends; null before any output. */
  result: ToolResultView | null;
  /** The result's text blocks joined, which is what the host's default body shows. */
  output: string;
  /** True while the tool is still running, so `result` is a partial one. */
  isPartial: boolean;
  isError: boolean;
  /** The card's expand toggle; a renderer decides what it hides while collapsed. */
  expanded: boolean;
}
/**
 * Custom timeline rendering for the tools a package registers, the web half
 * of the TUI's renderCall/renderResult. The host keeps the card frame (the
 * outcome tint, the status badge, the expand toggle) and hands the plugin the
 * header summary and the body: `call` replaces the argument summary beside
 * the tool name, `result` replaces the preformatted output. A half left out
 * keeps the host default. One tool name belongs to one renderer.
 */
export interface ToolRendererContribution {
  /** Tool names as registered with Pi (registerTool's `name`). */
  tools: string[];
  /**
   * Claims a tool named only at runtime (an MCP server's tools) when no
   * plugin lists the name. The session's footer statuses come along so the
   * plugin can read whatever its session half published, such as the server
   * names; the first renderer to match, in install order, wins.
   */
  matches?(toolName: string, statuses: Readonly<Record<string, string>>): boolean;
  call?: ComponentType<ToolCallRenderProps>;
  result?: ComponentType<ToolResultRenderProps>;
}
/** What a plugin's optional runtime may do; both send on the page's hub socket. */
export interface WebPluginRuntime {
  sendSessionFrame: SessionFrameSender;
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
  leaderBindings?: LeaderBindingContribution[];
  railSections?: SurfaceContribution[];
  selectionBarItems?: SurfaceContribution[];
  toolRenderers?: ToolRendererContribution[];
  /**
   * A section whose id names an activity group any plugin declares renders
   * inside that group's slot, `activity.<id>`, replacing the session's
   * one-line summary; any other section renders after the groups.
   */
  activitySections?: SurfaceContribution[];
  /** The slots this plugin opens for others, each named '<this plugin id>.<name>'. */
  slots?: SlotDeclaration[];
  /** This plugin's contributions into slots other plugins (or the host) declare. */
  fills?: SlotFillContribution[];
  /** Started after the host runtime, for page-lifetime needs such as hub frames; the return value disposes. */
  start?(runtime: WebPluginRuntime): (() => void) | void;
}

//# sourceMappingURL=webPlugin.d.mts.map
