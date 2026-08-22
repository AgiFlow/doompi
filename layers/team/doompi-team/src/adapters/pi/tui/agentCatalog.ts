import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_NAVIGATION_KEYS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from '@agimon-ai/doompi-ui/components/doomOverlay';
import { fitStyledLine } from '@agimon-ai/doompi-ui/rendering';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

import type { AgentConfig } from '../../agents/types';
import type {
  AgentCatalogEntry,
  AgentResourceProjection,
  ProjectedResource,
  ResourceTabProjection,
} from './agentResourceProjection';

export const AGENT_CATALOG_OVERLAY_OPTIONS = DOOM_FULLSCREEN_UI_OPTIONS.overlayOptions;
export type AgentResourceTab = 'tools' | 'skills' | 'extensions';

/** One subagent launch asked for from the catalog. `context` matches `/run --fork`. */
export interface AgentLaunchRequest {
  agent: string;
  task: string;
  context: 'fresh' | 'fork';
}

/**
 * Starts one run and returns immediately. The overlay closes on launch, so it
 * is not around to report an outcome: the launcher owns reporting both the
 * started run and any failure, where the user can still see them.
 */
export type AgentLaunchDispatcher = (request: AgentLaunchRequest) => void;

export interface AgentCatalogOptions {
  /**
   * Absent until a composition root wires a real launcher; the launch keys then
   * report that no launcher is attached rather than doing nothing. Injected so
   * the overlay can be asserted on its emitted payload in tests.
   */
  launchAgent?: AgentLaunchDispatcher;
}

type ThemeColor = Parameters<Theme['fg']>[0];

interface SplitLayout {
  leftContentWidth: number;
  rightContentWidth: number;
  gutterWidth: number;
}

const TITLE = 'AGENTS';
const BREADCRUMB = 'SPC › a / agents › l / available';
const SELECTION_MARKER = '›';
const ELLIPSIS = '…';
const DEFAULT_PAGE_SIZE = 1;
/**
 * A roster row is two lines: the agent name, then its source and runtime
 * beneath it. One line forced the name and the qualifier to share a width that
 * is a third of the overlay, which truncated the names - the one field a
 * reader picks a row by - to fit a qualifier that repeats on every row.
 */
const ROWS_PER_ENTRY = 2;
/** Indent under `${SELECTION_MARKER} `, so the meta line hangs under the name. */
const META_INDENT = '  ';
const PI_RUNTIME = 'pi';
const DIVIDER = '│';
const PROJECTED_EFFECTIVE = 'PROJECTED EFFECTIVE';
const REMOVED_BY_PARENT = 'REMOVED BY PARENT';
const UNRESOLVED_AT_PREVIEW = 'UNRESOLVED AT PREVIEW';
const PROJECTION_ERROR = 'PROJECTION ERROR';
const GLOBAL_PREVIEW_NOTICE =
  'Launch projection from the current parent-policy snapshot. Child resource loading can still change qualified resources.';
const TAB_ORDER: readonly AgentResourceTab[] = ['tools', 'skills', 'extensions'];
const FOOTER = `${DOOM_NAVIGATION_KEYS.list} cursor · ${DOOM_NAVIGATION_KEYS.detail} scroll · PgUp/PgDn page · tab resource · r run · R run fork · esc close`;
const FOOTER_HINTS: readonly (readonly [string, string])[] = [
  [DOOM_NAVIGATION_KEYS.list, 'move'],
  [DOOM_NAVIGATION_KEYS.detail, 'scroll'],
  ['tab', 'cycle'],
  ['r', 'run'],
];
const LAUNCH_FOOTER = 'enter launch · esc cancel';
const LAUNCH_FOOTER_HINTS: readonly (readonly [string, string])[] = [
  ['enter', 'launch'],
  ['esc', 'cancel'],
];
const LAUNCH_HEADING = 'LAUNCH TASK';
const LAUNCH_KEY = 'r';
const CURSOR_GLYPH = '▌';
const PROMPT_GLYPH = '❯';

function fitRow(text: string, width: number): string {
  return fitStyledLine(text, width, ELLIPSIS);
}

function rightAligned(left: string, right: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const rightWidth = visibleWidth(right);
  if (rightWidth + 2 >= safeWidth) return fitRow(left, safeWidth);
  const leftWidth = Math.max(1, safeWidth - rightWidth - 2);
  return `${fitRow(left, leftWidth)}  ${fitRow(right, rightWidth)}`;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function agentResourceSummary(agent: AgentConfig): string {
  const mcpTools = plural(agent.mcpDirectTools?.length ?? 0, 'MCP tool');
  const skills = plural(agent.skills?.length ?? 0, 'skill');
  const extensions = plural((agent.extensions?.length ?? 0) + (agent.subagentOnlyExtensions?.length ?? 0), 'extension');
  const configured = `${mcpTools} · ${skills} · ${extensions}`;
  return agent.tools === undefined
    ? `tools default · configured: ${configured}`
    : `configured: ${plural(agent.tools.length, 'tool')} · ${configured}`;
}

function appendWrapped(lines: string[], text: string, width: number, colour: ThemeColor, theme: Theme): void {
  for (const line of wrapTextWithAnsi(text, Math.max(1, width))) lines.push(theme.fg(colour, line));
}

function appendResources(
  lines: string[],
  heading: string,
  items: readonly ProjectedResource[],
  width: number,
  theme: Theme,
): void {
  lines.push(theme.bold(theme.fg('accent', heading)));
  if (items.length === 0) {
    lines.push(theme.fg('dim', '  none'));
  } else {
    for (const item of items) {
      appendWrapped(lines, `  • ${item.name}`, width, 'text', theme);
      if (item.detail) appendWrapped(lines, `    ${item.detail}`, width, 'dim', theme);
    }
  }
  lines.push('');
}

function tabProjection(projection: AgentResourceProjection, tab: AgentResourceTab): ResourceTabProjection {
  if (tab === 'skills') return projection.skills;
  if (tab === 'extensions') return projection.extensions;
  return projection.tools;
}

function resourceLines(
  projection: AgentResourceProjection,
  tab: AgentResourceTab,
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  if (projection.error) {
    lines.push(theme.bold(theme.fg('error', PROJECTION_ERROR)));
    appendWrapped(lines, projection.error, width, 'error', theme);
    lines.push('');
  }
  const resources = tabProjection(projection, tab);
  appendResources(lines, PROJECTED_EFFECTIVE, resources.effective, width, theme);
  appendResources(lines, REMOVED_BY_PARENT, resources.removed, width, theme);
  appendResources(lines, UNRESOLVED_AT_PREVIEW, resources.unresolved, width, theme);
  return lines;
}

function tabStrip(tab: AgentResourceTab, width: number, theme: Theme): string {
  const labels = TAB_ORDER.map((candidate) => {
    const label = candidate.toUpperCase();
    return candidate === tab ? theme.inverse(theme.bold(` ${label} `)) : theme.fg('dim', ` ${label} `);
  }).join(' ');
  return truncateToWidth(labels, Math.max(0, width), ELLIPSIS);
}

function splitLayout(width: number): SplitLayout {
  const paneBudget = Math.max(2, width - visibleWidth(DIVIDER));
  const leftPaneWidth = Math.max(1, Math.floor(paneBudget / 3));
  const rightPaneWidth = Math.max(1, paneBudget - leftPaneWidth);
  const gutterWidth = leftPaneWidth >= 3 && rightPaneWidth >= 3 ? 1 : 0;
  return {
    leftContentWidth: Math.max(1, leftPaneWidth - gutterWidth),
    rightContentWidth: Math.max(1, rightPaneWidth - gutterWidth),
    gutterWidth,
  };
}

export class AgentCatalogComponent extends DoomOverlay {
  private readonly entries: AgentCatalogEntry[];
  private cursorIndex = 0;
  private tab: AgentResourceTab = 'tools';
  private listPageSize = DEFAULT_PAGE_SIZE;
  private detailPageSize = DEFAULT_PAGE_SIZE;
  private detailOffset = 0;
  private detailTotal = 0;
  private launchDraft: string | undefined;
  private launchContext: AgentLaunchRequest['context'] = 'fresh';
  private launchTarget: string | undefined;
  private launchNotice: string | undefined;

  constructor(
    tui: DoomOverlayTui,
    theme: Theme,
    entries: readonly AgentCatalogEntry[],
    private readonly done: (result: undefined) => void,
    private readonly options: AgentCatalogOptions = {},
  ) {
    super(tui, theme);
    this.entries = [...entries].sort((left, right) => left.agent.name.localeCompare(right.agent.name));
  }

  private cursorEntry(): AgentCatalogEntry | undefined {
    return this.entries[Math.min(this.cursorIndex, Math.max(0, this.entries.length - 1))];
  }

  private moveCursor(delta: number): void {
    if (this.entries.length === 0) return;
    const next = Math.max(0, Math.min(this.entries.length - 1, this.cursorIndex + delta));
    if (next === this.cursorIndex) return;
    this.cursorIndex = next;
    // The detail pane follows the cursor, so its scroll belongs to the row that
    // was showing, not to the one that just replaced it.
    this.detailOffset = 0;
    this.invalidate();
  }

  private switchTab(tab: AgentResourceTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.detailOffset = 0;
    this.invalidate();
  }

  private cycleTab(): void {
    const current = TAB_ORDER.indexOf(this.tab);
    this.switchTab(TAB_ORDER[(current + 1) % TAB_ORDER.length] ?? 'tools');
  }

  private scrollDetail(delta: number): void {
    if (!this.cursorEntry()) return;
    const maximum = Math.max(0, this.detailTotal - this.detailPageSize);
    const next = Math.max(0, Math.min(maximum, this.detailOffset + delta));
    if (next === this.detailOffset) return;
    this.detailOffset = next;
    this.invalidate();
  }

  private setNotice(notice: string): void {
    this.launchNotice = notice;
    this.invalidate();
  }

  /** Opens the task prompt for the cursor agent; the launch itself waits on enter. */
  private beginLaunch(context: AgentLaunchRequest['context']): void {
    const entry = this.cursorEntry();
    if (!entry) {
      this.setNotice('launch unavailable · no agent is selected');
      return;
    }
    if (!this.options.launchAgent) {
      this.setNotice('launch unavailable · no subagent launcher is attached');
      return;
    }
    this.launchContext = context;
    this.launchTarget = entry.agent.name;
    this.launchDraft = '';
    this.launchNotice = undefined;
    this.invalidate();
  }

  private handleLaunchInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.launchDraft = undefined;
      this.setNotice('launch cancelled · no run started');
      return;
    }
    if (data === '\r' || data === '\n') {
      const task = (this.launchDraft ?? '').trim();
      const agent = this.launchTarget;
      const launchAgent = this.options.launchAgent;
      this.launchDraft = undefined;
      if (!agent || !task || !launchAgent) {
        this.setNotice('launch cancelled · a non-empty task is required');
        return;
      }
      // Closing first is what makes the launcher's own reporting visible: a
      // notification raised under a fullscreen overlay would be covered by it.
      this.done(undefined);
      launchAgent({ agent, task, context: this.launchContext });
      return;
    }
    if (data === '\x7f' || data === '\b') {
      this.launchDraft = (this.launchDraft ?? '').slice(0, -1);
      this.invalidate();
      return;
    }
    if (data.length === 1 && data >= ' ') {
      this.launchDraft = `${this.launchDraft ?? ''}${data}`;
      this.invalidate();
    }
  }

  handleInput(data: string): void {
    if (this.launchDraft !== undefined) {
      this.handleLaunchInput(data);
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
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
    if (matchesKey(data, 'up') || data === 'k') {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, 'down') || data === 'j') {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.moveCursor(-this.listPageSize);
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.moveCursor(this.listPageSize);
      return;
    }
    if (matchesKey(data, 'tab')) {
      this.cycleTab();
      return;
    }
    if (matchesKey(data, Key.shift(LAUNCH_KEY))) {
      this.beginLaunch('fork');
      return;
    }
    if (data === LAUNCH_KEY) {
      this.beginLaunch('fresh');
      return;
    }
    if (data === 't') this.switchTab('tools');
    else if (data === 's') this.switchTab('skills');
    else if (data === 'e') this.switchTab('extensions');
  }

  protected getChrome(): DoomOverlayChrome {
    const footerRight = this.entries.length ? `${this.cursorIndex + 1}/${this.entries.length}` : 'empty';
    const launching = this.launchDraft !== undefined;
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: `${this.entries.length} available · ${this.tab}`,
      footer: launching ? LAUNCH_FOOTER : FOOTER,
      footerHints: launching ? LAUNCH_FOOTER_HINTS : FOOTER_HINTS,
      footerRight,
    };
  }

  protected renderBody(width: number, height: number): string[] {
    // The prompt and the notice are drawn under both panes, so the split
    // itself renders into whatever height is left after they claim their rows.
    const transientRows = (this.launchDraft !== undefined ? 2 : 0) + (this.launchNotice !== undefined ? 1 : 0);
    const mainHeight = Math.max(0, height - transientRows);
    const layout = splitLayout(width);
    const left = this.renderList(layout.leftContentWidth, mainHeight);
    const right = this.renderDetail(layout.rightContentWidth, mainHeight);
    const gutter = ' '.repeat(layout.gutterWidth);
    const divider = this.theme.fg('borderMuted', DIVIDER);
    const lines: string[] = [];
    for (let index = 0; index < mainHeight; index++) {
      lines.push(
        `${fitRow(left[index] ?? '', layout.leftContentWidth)}${gutter}${divider}${gutter}${fitRow(
          right[index] ?? '',
          layout.rightContentWidth,
        )}`,
      );
    }
    if (this.launchDraft !== undefined) {
      const target = `${this.launchTarget ?? ''} · ${this.launchContext}`;
      lines.push(` ${this.theme.bold(this.theme.fg('accent', LAUNCH_HEADING))} ${this.theme.fg('dim', target)}`);
      lines.push(` ${this.theme.fg('accent', PROMPT_GLYPH)} ${this.launchDraft}${CURSOR_GLYPH}`);
    }
    if (this.launchNotice !== undefined) lines.push(` ${this.theme.fg('muted', this.launchNotice)}`);
    return lines.slice(0, height).map((line) => fitRow(line, width));
  }

  private renderList(width: number, height: number): string[] {
    const lines = [this.theme.bold(this.theme.fg('accent', `AGENTS ${this.entries.length}`))];
    if (this.entries.length === 0) {
      appendWrapped(lines, 'No enabled agents are available from this session cwd.', width, 'dim', this.theme);
      this.listPageSize = DEFAULT_PAGE_SIZE;
      return lines.slice(0, height);
    }

    this.listPageSize = Math.max(DEFAULT_PAGE_SIZE, Math.floor((height - 1) / ROWS_PER_ENTRY));
    const start = Math.max(
      0,
      Math.min(this.cursorIndex - this.listPageSize + 1, Math.max(0, this.entries.length - this.listPageSize)),
    );
    for (const [offset, entry] of this.entries.slice(start, start + this.listPageSize).entries()) {
      const index = start + offset;
      const current = index === this.cursorIndex;
      const marker = current ? this.theme.fg('accent', SELECTION_MARKER) : ' ';
      const runtime = entry.agent.runtime ?? PI_RUNTIME;
      // No row background: the marker and the accented name carry selection,
      // and a filled block behind every row read as one solid panel instead.
      const name = current
        ? this.theme.bold(this.theme.fg('accent', entry.agent.name))
        : this.theme.fg('text', entry.agent.name);
      const meta = this.theme.fg('dim', `${entry.agent.source} · ${runtime}`);
      lines.push(fitRow(`${marker} ${name}`, width));
      lines.push(fitRow(`${META_INDENT}${meta}`, width));
    }
    return lines.slice(0, height);
  }

  private renderDetail(width: number, height: number): string[] {
    const entry = this.cursorEntry();
    if (!entry) {
      this.detailTotal = 0;
      this.detailPageSize = Math.max(DEFAULT_PAGE_SIZE, height);
      this.detailOffset = 0;
      const lines = [this.theme.bold(this.theme.fg('accent', 'AGENT RESOURCES')), ''];
      appendWrapped(lines, 'No enabled agents are available from this session cwd.', width, 'text', this.theme);
      lines.push('');
      appendWrapped(lines, GLOBAL_PREVIEW_NOTICE, width, 'dim', this.theme);
      return lines.slice(0, height);
    }

    const runtime = entry.agent.runtime ?? PI_RUNTIME;
    const header = [
      rightAligned(
        this.theme.bold(this.theme.fg('accent', `INSPECTING ${entry.agent.name}`)),
        `${entry.agent.source} · ${runtime}`,
        width,
      ),
    ];
    appendWrapped(header, entry.agent.description, width, 'text', this.theme);
    appendWrapped(
      header,
      entry.resources.notice || GLOBAL_PREVIEW_NOTICE,
      width,
      entry.resources.configuredOnly ? 'warning' : 'dim',
      this.theme,
    );
    header.push(tabStrip(this.tab, width, this.theme), '');

    const resources = resourceLines(entry.resources, this.tab, width, this.theme);
    this.detailPageSize = Math.max(0, height - header.length);
    this.detailTotal = resources.length;
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, resources.length - this.detailPageSize));
    return [...header, ...resources.slice(this.detailOffset, this.detailOffset + this.detailPageSize)].slice(0, height);
  }
}

export async function openAgentCatalog(
  ctx: ExtensionContext,
  entries: readonly AgentCatalogEntry[],
  options: AgentCatalogOptions = {},
): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new AgentCatalogComponent(tui, theme, entries, done, options),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
