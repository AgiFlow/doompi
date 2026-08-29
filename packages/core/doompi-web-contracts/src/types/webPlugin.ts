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
/**
 * A tab a plugin opens at runtime for one session, beside the declared ones:
 * the reader closes it, and it goes with the session or the page. The host
 * keeps the panel it was opened with, so opening the same id again only
 * focuses the tab.
 */
export interface TransientTab {
  /** Unique across plugins and URL-safe: '<pluginId>-<name>-<key>'. */
  id: string;
  label: string;
  panel: ComponentType<WebPluginSlotProps>;
}
/** Every slot component receives the focused session; null while nothing is focused. */
export interface WebPluginSlotProps {
  sessionId: string | null;
  /** Host navigation for the focused session; null returns to the conversation tab. */
  openTab: (tabId: string | null) => void;
  /** Opens the tab for the focused session, or focuses it when one with the same id is already open. */
  openTransientTab: (tab: TransientTab) => void;
  closeTransientTab: (tabId: string) => void;
  /**
   * The host's live conversation view of one thread of the focused session,
   * rendered like the session's own timeline and subscribed while mounted. A
   * plugin's hub source names the thread's journal (HubChannelSource.threadJournal).
   */
  renderThread: (threadId: string) => ReactNode;
  /** The same sender palette commands and `start` receive; components act through it. */
  sendSessionFrame: SessionFrameSender;
  /** The component fills of one slot, in slot order; the host resolves them, so this contract holds no state. */
  renderSlot: (slot: string) => ReactNode;
  /** The data fills of one slot, typed by the declaration handle only its owner holds. */
  slotData: <Data>(slot: SlotDeclaration<Data>) => readonly SlotDataFill<Data>[];
  /**
   * The footer statuses the focused session has published, raw, keyed as the
   * publishing extension named them. A package reads its own key: the status
   * line is the only thing some modes report, and a plugin that renders its
   * own surface needs the same facts the host folds into the selection bar.
   */
  statuses: Readonly<Record<string, string>>;
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
/**
 * One field on a settings page, declared as data.
 *
 * Settings are data rather than a component because the host owns what a
 * plugin cannot: which file an edit lands in. A page has one scope switch and
 * one repository, and every field on it reports where its value came from and
 * whether the selected scope may hold it. A plugin drawing its own form would
 * have to reproduce all of that, and each would get it slightly different.
 */
export interface SettingsFieldContribution {
  /** Unique within the section; also the testid suffix. */
  id: string;
  label: string;
  kind: 'text' | 'select' | 'toggle' | 'info';
  /** The config key this reads and writes, e.g. ['modes','planning','main','model']. */
  keyPath: readonly string[];
  /** One line of help under the field. */
  detail?: string;
  /** Shown while the field is unset, in place of a value. */
  placeholder?: string;
  /** The closed set a 'select' offers, when the plugin knows it. */
  options?: readonly SettingsFieldOption[];
  /**
   * An option set the host supplies instead. A model picker needs the machine's
   * authenticated models, which no plugin can enumerate from the browser; a
   * host that cannot answer leaves the field as free text.
   */
  optionsFrom?: 'models';
}
export interface SettingsFieldOption {
  value: string;
  label: string;
  /** Groups entries under a heading, as providers group their models. */
  group?: string;
}
/**
 * A page in cockpit settings, contributed by the package that owns the
 * settings on it. The id is the URL segment (/settings/:id), so it is unique
 * across plugins; a collision is an install diagnostic and the first wins.
 */
export interface SettingsSectionContribution {
  id: string;
  label: string;
  detail: string;
  /** Sort position in the settings menu; lower first, id breaks ties. */
  order?: number;
  fields: readonly SettingsFieldContribution[];
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
  /**
   * The catalog mode this row drives, when the runtime registers it under a
   * different id than the row shows. A package whose leader key drives one of
   * several modes it owns needs this: the row must reach the same mode the
   * key does, not the one that happens to share the row's label.
   */
  modeId?: string;
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
  /**
   * Drop the group entirely while its status key is present but empty, rather
   * than showing a header over "idle".
   *
   * A session publishes a status key once and clears it by publishing nothing,
   * which reaches the page as an empty string, so a group that has reported at
   * all can never stop reporting. For a group whose whole content is the thing
   * the session is doing (a goal, a recording, the files it changed), the
   * header alone is a row that says nothing, and a dock of those buries the
   * groups that do. A group that is also a way in, with a launcher or a tab,
   * leaves this off: its frame is worth keeping when it is idle.
   */
  hideWhenEmpty?: boolean;
  /** Keeps the group visible below the dock's scrolling ordinary groups. */
  placement?: 'bottom';
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
/**
 * Everything a tool's timeline item receives: the actions every plugin
 * component gets, plus the call and its newest result. The component owns
 * the whole item, its frame, header, body, and expand state included; the
 * host only wraps it in the timeline row and catches a throw. Compose it
 * from the shared components package's MessageItem so it looks like every
 * other item, the host's own fallback included.
 */
export interface ToolMessageRenderProps extends WebPluginSlotProps {
  toolCallId: string;
  /** The wire name, as registered with Pi (registerTool's `name`). */
  toolName: string;
  args: Record<string, unknown>;
  /** The session's footer statuses at render time, the same picture `matches` saw. */
  statuses: Readonly<Record<string, string>>;
  /** The newest result: partial while the tool runs, final once it ends; null before any output. */
  result: ToolResultView | null;
  /** The result's text blocks joined, which is what the host's fallback item shows. */
  output: string;
  /** True while the tool still runs, so `result` is a partial one. */
  running: boolean;
  isError: boolean;
}
/** The extension UI request a running tool is blocked on, as its prompt sees it. */
export interface ToolPromptDialog {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message: string;
  options: readonly string[];
  placeholder: string;
  prefill: string;
}
/**
 * Everything a tool's composer prompt receives: the timeline item's props,
 * plus the request the tool is waiting on and the two ways to settle it.
 *
 * The dialog frame is deliberately thin, because Pi's own is: a select
 * carries a title and a list of labels and nothing else. A prompt that needs
 * more renders it from `args`, which is the whole call the tool was made
 * with, and answers with whatever its session half agreed to read back.
 */
export interface ToolPromptRenderProps extends ToolMessageRenderProps {
  dialog: ToolPromptDialog;
  /** Answers the request and unblocks the tool. Bound, so a prompt may destructure it. */
  answer: (value: string) => void;
  /** The reader declined; the tool sees a cancellation. */
  cancel: () => void;
}
/**
 * A tool's stand-in for the composer input, shown while the tool is running
 * and holding an extension UI request.
 *
 * A question the agent is blocked on belongs where the reader is already
 * looking and typing, not behind a modal covering the conversation they need
 * in order to answer. While a prompt is up the host's own dialog stands down,
 * so exactly one surface owns the request.
 */
export interface ToolPromptContribution {
  /**
   * True when this tool owns the open request. Without it the tool claims any
   * request open while it runs, which is wrong the moment a second extension
   * asks something during the same turn; a request it refuses falls back to
   * the host's dialog.
   */
  claims?(dialog: ToolPromptDialog, args: Record<string, unknown>): boolean;
  component: ComponentType<ToolPromptRenderProps>;
}
/**
 * The timeline item for the tools a package registers, the web half of the
 * TUI's renderCall/renderResult with Pi's renderShell 'self': one `message`
 * component per claimed tool owns the whole item. One tool name belongs to
 * one renderer.
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
  message: ComponentType<ToolMessageRenderProps>;
  /** Stands in for the composer input while this tool runs and holds a request. */
  prompt?: ToolPromptContribution;
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
  /** Compact controls placed in the mobile composer's action row, immediately before queue. */
  composerActions?: SurfaceContribution[];
  toolRenderers?: ToolRendererContribution[];
  /**
   * A section whose id names an activity group any plugin declares renders
   * inside that group's slot, `activity.<id>`, replacing the session's
   * one-line summary; any other section renders after the groups.
   */
  activitySections?: SurfaceContribution[];
  /**
   * Pages this plugin adds to cockpit settings. The host renders the fields and
   * owns the scope switch, the repository picker, and every write.
   */
  settingsSections?: SettingsSectionContribution[];
  /** The slots this plugin opens for others, each named '<this plugin id>.<name>'. */
  slots?: SlotDeclaration[];
  /** This plugin's contributions into slots other plugins (or the host) declare. */
  fills?: SlotFillContribution[];
  /** Started after the host runtime, for page-lifetime needs such as hub frames; the return value disposes. */
  start?(runtime: WebPluginRuntime): (() => void) | void;
}
