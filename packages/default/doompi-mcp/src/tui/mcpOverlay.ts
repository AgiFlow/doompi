/**
 * MCP browser: the `SPC e m` overlay.
 *
 * A roster of this session's MCP servers on the left, and on the right what the
 * selected one offers plus the controls that act on it. It replaces a `/mcp status`
 * text blob that could be read but not acted on.
 *
 * DESIGN PATTERNS:
 * - Controls always list every action, unavailable ones dimmed rather than hidden,
 *   so the key map never shifts under the user
 * - Every collaborator arrives through `McpOverlayTarget`, so the component renders
 *   and dispatches in a test with no terminal and no session behind it
 *
 * The roster stays a flat list and the detail pane a tab strip rather than a second
 * navigation level: selection is one index, and every row is assertable as a string.
 *
 * Repainting is driven by `target.onChange`, not a timer. Servers connect on their
 * own schedule and the session already announces each one as it folds in, so a poll
 * here would only be sampling an event that had already fired.
 *
 * Disabling is a visibility control, not a permission boundary: Pi 0.84 cannot
 * unregister a tool, so a disabled server's tools leave the active list but stay
 * registered and callable. `DirectToolFilter` has the same property.
 */

import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { McpOverlayTarget, McpResourceView, McpServerView } from '../types/mcp.ts';

const TITLE = 'MCP';
const BREADCRUMB = 'SPC › e / m · mcp';
/**
 * Ordered by what a user reaches for first, because the chrome drops trailing
 * hints rather than shrinking them when the terminal is narrow.
 *
 * Scrolling earns a slot: a long tool list is the common case (the proxy alone
 * carries twelve), and without a legend entry the keys that reach the rest of it
 * are undiscoverable.
 */
const HINTS: readonly (readonly [string, string])[] = [
  [DOOM_NAVIGATION_KEYS.list, 'server'],
  [DOOM_NAVIGATION_KEYS.detail, 'scroll'],
  ['tab', 'pane'],
  ['a', 'auth'],
  ['d', 'disable'],
  ['e', 'enable'],
  ['r', 'reload'],
  ['esc', 'close'],
];
/** Derived so the plain-text fallback cannot drift from the caps above it. */
const FOOTER_FALLBACK = HINTS.map(([key, label]) => `${key} ${label}`).join(' · ');
/** Matches the chrome's spacing between footer caps, so both legends read alike. */
const CAP_SEPARATOR = '   ';

const MIN_WIDTH = 48;
/** A third for the roster, two thirds for what the server offers. */
const ROSTER_PANE_RATIO = 1 / 3;
const PANE_GUTTER = 1;
const MIN_PANE_WIDTH = 18;
const ELLIPSIS = '…';
const LABEL_COLUMN = 10;
const FIELD_FALLBACK = '—';
const EMPTY_MESSAGE = 'No MCP servers are configured for this session.';
const TOOL_INDENT = '  ';
const OSC_LINK_OPEN = '\u001B]8;;';
const OSC_LINK_SEPARATOR = '\u0007';
const OSC_LINK_CLOSE = `${OSC_LINK_OPEN}${OSC_LINK_SEPARATOR}`;

export type McpDetailTab = 'tools' | 'resources';
const DETAIL_TABS: readonly McpDetailTab[] = ['tools', 'resources'];

type McpActionName = 'auth' | 'disable' | 'enable';

const CONTROL_ORDER: readonly McpActionName[] = ['auth', 'disable', 'enable'];
const CONTROL_KEY: Record<McpActionName, string> = { auth: 'a', disable: 'd', enable: 'e' };
/** Short qualifier where the verb alone would understate what the key does. */
const CONTROL_HINT: Record<McpActionName, string | undefined> = {
  auth: 'reconnect',
  disable: 'session',
  enable: undefined,
};
const CONTROL_BY_KEY = new Map<string, McpActionName>(CONTROL_ORDER.map((action) => [CONTROL_KEY[action], action]));

/**
 * What each control can do to a server in its current condition.
 *
 * `auth` reconnects wherever that is meaningful, including a server that has not
 * been dialled yet. Mid-connect it is withheld until the flow has a reserved URL;
 * from then on the same key safely reopens that page without reconnecting.
 */
function controlAvailability(server: McpServerView | undefined): Record<McpActionName, boolean> {
  if (!server) return { auth: false, disable: false, enable: false };
  if (!server.enabled) return { auth: false, disable: false, enable: true };
  return { auth: server.authorizationUrl !== undefined || server.state !== 'connecting', disable: true, enable: false };
}

function unavailableReason(action: McpActionName, server: McpServerView | undefined): string {
  if (!server) return `${action} unavailable · no server is selected`;
  if (!server.enabled) return `${action} unavailable · ${server.name} is disabled for this session`;
  if (action === 'enable') return `enable unavailable · ${server.name} is already enabled`;
  return `${action} unavailable · ${server.name} is ${server.state}`;
}

function statusGlyph(server: McpServerView, theme: Theme): string {
  if (!server.enabled) return theme.fg('dim', '■');
  if (server.state === 'connected') return theme.fg('success', '●');
  if (server.state === 'connecting') return theme.fg('accent', '◐');
  if (server.state === 'degraded') return theme.fg('warning', '▲');
  if (server.state === 'needs-auth') return theme.fg('warning', '✗');
  if (server.state === 'failed') return theme.fg('error', '✗');
  return theme.fg('muted', '◦');
}

/** What the roster row and the detail header both call the server's condition. */
function stateLabel(server: McpServerView): string {
  return server.enabled ? server.state : 'disabled';
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), ELLIPSIS);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fit(left, leftWidth) + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + fit(right, rightWidth);
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** A compact clickable fallback whose visible width does not include its target URL. */
function terminalLink(label: string, url: string): string {
  return `${OSC_LINK_OPEN}${url}${OSC_LINK_SEPARATOR}${label}${OSC_LINK_CLOSE}`;
}

/** What the resources pane knows about one server. Absent until the pane asks. */
interface ResourcePane {
  status: 'loading' | 'ready' | 'error';
  items?: readonly McpResourceView[];
  error?: string;
}

export class McpOverlayComponent extends DoomOverlay {
  private servers: readonly McpServerView[] = [];
  private selected = 0;
  private selectedName: string | undefined;
  private detailTab: McpDetailTab = 'tools';
  private detailScroll = 0;
  private detailLineCount = 0;
  private detailViewportHeight = 8;
  private bodyHeight = 8;
  private actionNotice: string | undefined;
  private disposed = false;
  private readonly resourcePanes = new Map<string, ResourcePane>();
  private readonly unsubscribe: () => void;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    private readonly target: McpOverlayTarget,
    private readonly done: (result: undefined) => void,
  ) {
    super(tui, theme);
    this.refresh();
    this.unsubscribe = this.target.onChange(() => {
      if (this.disposed) return;
      this.refresh();
      // A flow that has surfaced its URL is no longer dispatching. Explicit auth
      // opens it automatically, while the same key now reopens the reserved page.
      const server = this.current();
      if (server?.authorizationUrl) this.actionNotice = `auth ${server.name} · page ready · a reopens browser`;
      this.tui.requestRender();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }

  /** Re-reads the roster, keeping the cursor on the server it was already on. */
  private refresh(): void {
    const previousName = this.servers[this.selected]?.name ?? this.selectedName;
    this.servers = this.target.getServers();
    const preserved = previousName ? this.servers.findIndex((server) => server.name === previousName) : -1;
    this.selected = preserved >= 0 ? preserved : Math.min(this.selected, Math.max(0, this.servers.length - 1));
    this.selectedName = this.servers[this.selected]?.name;
  }

  private current(): McpServerView | undefined {
    return this.servers[this.selected];
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'q')) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.shift('k'))) {
      this.scrollDetail(-1);
      return;
    }
    if (matchesKey(data, Key.shift('j'))) {
      this.scrollDetail(1);
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.scrollDetail(-this.detailViewportHeight);
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.scrollDetail(this.detailViewportHeight);
      return;
    }
    if (matchesKey(data, 'tab')) {
      this.toggleTab();
      return;
    }
    // Checked before the single-letter controls: ctrl+r is the deliberate path that
    // discards what a server said about its resources and asks again.
    if (matchesKey(data, 'ctrl+r')) {
      this.loadResources({ refresh: true });
      return;
    }
    if (matchesKey(data, 'r')) {
      this.reload();
      return;
    }
    const action = CONTROL_BY_KEY.get(data.toLowerCase());
    if (action) this.triggerControl(action);
  }

  private moveSelection(delta: number): void {
    if (this.servers.length === 0) return;
    this.selected = Math.max(0, Math.min(this.servers.length - 1, this.selected + delta));
    this.selectedName = this.servers[this.selected]?.name;
    this.detailScroll = 0;
    this.maybeLoadResources();
    this.tui.requestRender();
  }

  private scrollDetail(delta: number): void {
    const maxScroll = Math.max(0, this.detailLineCount - this.detailViewportHeight);
    this.detailScroll = Math.max(0, Math.min(maxScroll, this.detailScroll + delta));
    this.tui.requestRender();
  }

  private toggleTab(): void {
    this.detailTab = this.detailTab === 'tools' ? 'resources' : 'tools';
    this.detailScroll = 0;
    this.maybeLoadResources();
    this.tui.requestRender();
  }

  private reload(): void {
    this.setNotice('reload · dispatching…');
    // Not awaited: a server that never answers must not wedge the overlay. The
    // roster repaints through onChange as each one lands.
    void this.target
      .start()
      .then(() => {
        if (!this.disposed) this.setNotice('reload · reconnecting');
      })
      .catch((cause: unknown) => {
        if (!this.disposed) this.setNotice(`reload · failed · ${message(cause)}`);
      });
  }

  /**
   * Lists the selected server's resources, but only where a listing is meaningful.
   *
   * A server that has not connected is left alone: turning a `tab` keypress into a
   * silent dial-out is not what switching panes should mean.
   */
  private maybeLoadResources(): void {
    if (this.detailTab !== 'resources') return;
    const server = this.current();
    if (!server || !server.enabled || server.state !== 'connected') return;
    if (this.resourcePanes.has(server.name)) return;
    this.loadResources();
  }

  private loadResources(options: { refresh?: boolean } = {}): void {
    const server = this.current();
    if (!server) return;
    this.resourcePanes.set(server.name, { status: 'loading' });
    this.tui.requestRender();
    void this.target
      .listResources(server.name, options)
      .then((items) => {
        if (this.disposed) return;
        this.resourcePanes.set(server.name, { status: 'ready', items });
        this.tui.requestRender();
      })
      .catch((cause: unknown) => {
        if (this.disposed) return;
        this.resourcePanes.set(server.name, { status: 'error', error: message(cause) });
        this.tui.requestRender();
      });
  }

  private triggerControl(action: McpActionName): void {
    const server = this.current();
    if (!controlAvailability(server)[action]) {
      this.setNotice(unavailableReason(action, server));
      return;
    }
    if (!server) return;
    if (action === 'auth') {
      if (server.authorizationUrl) void this.openAuthorizationPage(server.name);
      else void this.authorize(server.name);
      return;
    }
    const enabled = action === 'enable';
    try {
      this.target.setEnabled(server.name, enabled);
      this.refresh();
      this.setNotice(`${action} ${server.name} · ${enabled ? 'tools restored' : 'tools withheld for this session'}`);
    } catch (cause) {
      this.setNotice(`${action} ${server.name} · failed · ${message(cause)}`);
    }
  }

  private async authorize(serverName: string): Promise<void> {
    this.setNotice(`auth ${serverName} · dispatching…`);
    try {
      await this.target.reauthorize(serverName);
      if (this.disposed) return;
      // The listing is about whatever the reconnect just settled on.
      this.resourcePanes.delete(serverName);
      this.refresh();
      this.setNotice(`auth ${serverName} · authorized`);
    } catch (cause) {
      if (this.disposed) return;
      this.setNotice(`auth ${serverName} · failed · ${message(cause)}`);
    }
  }

  private async openAuthorizationPage(serverName: string): Promise<void> {
    this.setNotice(`auth ${serverName} · opening browser…`);
    try {
      await this.target.openAuthorizationPage(serverName);
      if (!this.disposed) this.setNotice(`auth ${serverName} · browser opened · waiting for approval`);
    } catch (cause) {
      if (!this.disposed) this.setNotice(`auth ${serverName} · browser failed · ${message(cause)}`);
    }
  }

  private setNotice(notice: string): void {
    this.actionNotice = notice;
    this.tui.requestRender();
  }

  private rosterLines(width: number): string[] {
    if (this.servers.length === 0) return [this.theme.fg('dim', 'No servers')];
    const start = Math.max(
      0,
      Math.min(this.selected - this.bodyHeight + 1, Math.max(0, this.servers.length - this.bodyHeight)),
    );
    return this.servers.slice(start, start + this.bodyHeight).map((server, offset) => {
      const index = start + offset;
      const marker = index === this.selected ? this.theme.fg('accent', '›') : ' ';
      // Dimming a disabled server states in the roster what the detail pane would
      // otherwise have to be visited to learn.
      const name = server.enabled
        ? index === this.selected
          ? this.theme.bold(server.name)
          : server.name
        : this.theme.fg('dim', server.name);
      const left = `${marker} ${statusGlyph(server, this.theme)} ${name}`;
      return rightAligned(left, this.theme.fg('dim', stateLabel(server)), width);
    });
  }

  /**
   * A single-line fallback for the page that explicit auth already opened.
   *
   * The full URL lives in an OSC 8 target rather than printable layout cells, so a
   * long OAuth state token cannot wrap through pane borders and become corrupted.
   * Terminals without clickable links still have the same `a` key to reopen it.
   */
  private authorizationLines(url: string, width: number): string[] {
    return [
      this.theme.fg('accent', fit(`${TOOL_INDENT}Authorization page ready`, width)),
      this.theme.fg('text', fit(`${TOOL_INDENT}${terminalLink('Open authorization page', url)} · a reopens`, width)),
    ];
  }

  private field(label: string, value: string, width: number): string[] {
    const valueWidth = Math.max(1, width - LABEL_COLUMN);
    return wrap(value, valueWidth).map(
      (line, index) => `${this.theme.fg('dim', fit(index === 0 ? label : '', LABEL_COLUMN))}${fit(line, valueWidth)}`,
    );
  }

  /**
   * Runtime controls as filled key caps, matching the footer legend.
   *
   * Every action is always listed; an unavailable one loses its cap fill rather
   * than its place, so the key map never shifts under the user and a control that
   * cannot act still reads as a key rather than as prose.
   */
  private controlLine(server: McpServerView | undefined, width: number): string {
    const availability = controlAvailability(server);
    const parts = CONTROL_ORDER.map((action) => {
      const hint = action === 'auth' && server?.authorizationUrl ? 'reopen' : CONTROL_HINT[action];
      const label = `${action}${hint ? ` (${hint})` : ''}`;
      return this.keyCap(CONTROL_KEY[action], label, availability[action]);
    });
    return truncateToWidth(`  ${parts.join(CAP_SEPARATOR)}`, width);
  }

  /** One filled key cap and its label. Unfilled when the key would do nothing. */
  private keyCap(key: string, label: string, enabled = true): string {
    const cap = enabled
      ? this.theme.bg('selectedBg', this.theme.fg('text', ` ${key} `))
      : this.theme.fg('dim', ` ${key} `);
    return `${cap}${this.theme.fg('dim', ` ${label}`)}`;
  }

  private tabStrip(server: McpServerView | undefined, width: number): string {
    const label = (name: McpDetailTab): string =>
      name === this.detailTab
        ? this.theme.fg('accent', this.theme.bold(`[ ${name} ]`))
        : this.theme.fg('dim', `  ${name}  `);
    const counts =
      server && this.detailTab === 'tools'
        ? `${server.tools.filter((tool) => tool.active).length}/${server.tools.length}`
        : 'ctrl+r refresh';
    return rightAligned(`  ${DETAIL_TABS.map(label).join('')}`, this.theme.fg('dim', counts), width);
  }

  private toolLines(server: McpServerView, width: number): string[] {
    if (server.tools.length === 0) return [this.theme.fg('dim', `${TOOL_INDENT}No tools`)];
    const lines: string[] = [];
    for (const tool of server.tools) {
      // Colour separates what the model can call from what is merely registered,
      // so a withheld tool never has to be selected to be recognised.
      const usable = tool.active && server.enabled;
      lines.push(this.theme.fg(usable ? 'text' : 'dim', fit(`${TOOL_INDENT}${tool.toolName}`, width)));
      if (tool.description) {
        for (const line of wrap(tool.description, Math.max(1, width - TOOL_INDENT.length * 2))) {
          lines.push(this.theme.fg('dim', `${TOOL_INDENT}${TOOL_INDENT}${line}`));
        }
      }
    }
    return lines;
  }

  private resourceLines(server: McpServerView, width: number): string[] {
    const pane = this.resourcePanes.get(server.name);
    if (!pane) {
      return [
        this.theme.fg(
          'dim',
          `${TOOL_INDENT}${server.state === 'connected' && server.enabled ? 'Press ctrl+r to list resources' : `${server.name} is ${stateLabel(server)} · press ctrl+r to try anyway`}`,
        ),
      ];
    }
    if (pane.status === 'loading') return [this.theme.fg('dim', `${TOOL_INDENT}Listing resources…`)];
    if (pane.status === 'error') {
      return wrap(
        `Could not list resources: ${pane.error ?? 'unknown error'}`,
        Math.max(1, width - TOOL_INDENT.length),
      ).map((line) => this.theme.fg('warning', `${TOOL_INDENT}${line}`));
    }
    const items = pane.items ?? [];
    if (items.length === 0) return [this.theme.fg('dim', `${TOOL_INDENT}No resources`)];
    return items.flatMap((resource) => {
      const lines = [
        rightAligned(
          `${TOOL_INDENT}${resource.name ?? resource.uri}`,
          this.theme.fg('dim', resource.mimeType ?? ''),
          width,
        ),
      ];
      if (resource.name) lines.push(this.theme.fg('dim', fit(`${TOOL_INDENT}${TOOL_INDENT}${resource.uri}`, width)));
      if (resource.description) {
        for (const line of wrap(resource.description, Math.max(1, width - TOOL_INDENT.length * 2))) {
          lines.push(this.theme.fg('dim', `${TOOL_INDENT}${TOOL_INDENT}${line}`));
        }
      }
      return lines;
    });
  }

  private detailLines(width: number, height: number): string[] {
    const server = this.current();
    if (!server) return [this.theme.fg('dim', EMPTY_MESSAGE)];

    const summary = [
      stateLabel(server),
      `${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`,
      `${server.resourceCount} res`,
    ].join(' · ');
    const header = [
      this.theme.bold(server.name),
      '',
      ...this.field('State', summary, width),
      ...this.field('Error', server.error ?? FIELD_FALLBACK, width),
      // The compact label is clickable, while `a` reopens the same reserved URL.
      ...(server.authorizationUrl ? ['', ...this.authorizationLines(server.authorizationUrl, width)] : []),
      '',
      this.controlLine(server, width),
      '',
      this.tabStrip(server, width),
      '',
    ];

    const body = this.detailTab === 'tools' ? this.toolLines(server, width) : this.resourceLines(server, width);
    this.detailLineCount = body.length;
    this.detailViewportHeight = Math.max(1, height - header.length);
    const start = Math.min(this.detailScroll, Math.max(0, body.length - this.detailViewportHeight));
    return [...header, ...body.slice(start, start + this.detailViewportHeight)];
  }

  protected getChrome(): DoomOverlayChrome {
    const connected = this.servers.filter((server) => server.enabled && server.state === 'connected').length;
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: `${connected}/${this.servers.length} connected · esc close`,
      // The chrome renders the caps and decides what fits; `footer` is only the
      // plain-sentence fallback it uses when hints are absent.
      footer: FOOTER_FALLBACK,
      footerHints: HINTS,
    };
  }

  /**
   * The notice line, on its own full-width row at the foot of the body.
   *
   * Not `footerRight`: the chrome drops a right-hand status whole when the row
   * cannot spare the columns, and the hint legend always claims them, so an action's
   * only feedback would be silently discarded on every terminal.
   */
  private noticeRow(width: number): string {
    return this.theme.fg('warning', fit(`  ${this.actionNotice ?? ''}`, width));
  }

  protected renderBody(width: number, height: number): string[] {
    const paneHeight = this.actionNotice ? Math.max(1, height - 1) : height;
    const notice = this.actionNotice ? [this.noticeRow(width)] : [];
    this.bodyHeight = paneHeight;
    if (width < MIN_WIDTH) return [...this.renderStacked(width, paneHeight), ...notice];

    const leftWidth = Math.max(MIN_PANE_WIDTH, Math.floor((width - 1) * ROSTER_PANE_RATIO));
    const rightWidth = Math.max(1, width - leftWidth - 1);
    const leftContent = Math.max(1, leftWidth - PANE_GUTTER);
    const rightContent = Math.max(1, rightWidth - PANE_GUTTER);
    const left = this.rosterLines(leftContent);
    const right = this.detailLines(rightContent, paneHeight);

    const divider = this.theme.fg('borderMuted', '│');
    const rows = Array.from({ length: paneHeight }, (_, index) => {
      const row = `${fit(left[index] ?? '', leftContent)} ${divider} ${fit(right[index] ?? '', rightContent)}`;
      return truncateToWidth(row, width, ELLIPSIS);
    });
    return [...rows, ...notice];
  }

  private renderStacked(width: number, height: number): string[] {
    const topHeight = Math.max(1, Math.floor((height - 1) / 2));
    const bottomHeight = Math.max(0, height - topHeight - 1);
    this.bodyHeight = topHeight;
    const top = this.rosterLines(width);
    const bottom = this.detailLines(width, bottomHeight);
    return [
      ...top.slice(0, topHeight),
      ...Array.from({ length: Math.max(0, topHeight - top.length) }, () => ''),
      this.theme.fg('borderMuted', '─'.repeat(width)),
      ...bottom.slice(0, bottomHeight),
    ];
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function openMcpOverlay(ctx: ExtensionContext, target: McpOverlayTarget): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new McpOverlayComponent(tui, theme, target, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
