/**
 * Tools browser: the `SPC e t` overlay.
 *
 * A grouped list on the left (Pi core, one group per MCP server, one per
 * extension) and a detail pane on the right for the tool under the cursor.
 * Read-only: nothing here enables or disables a tool, so it cannot fight plan
 * mode or the workflow dispatcher over the active tool set.
 *
 * Group headings are labels, not controls: everything is always expanded and
 * the cursor steps over them, so there is no expansion state to track and the
 * whole inventory is legible without navigating it. The tree stays a flat row
 * list, which keeps selection a single index and every row assertable as text.
 */

import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { ToolEntry, ToolSource } from '../services/tools/toolInventory.ts';
import {
  DOOM_FULLSCREEN_UI_OPTIONS,
  DOOM_OVERLAY_ACCENT,
  DoomOverlay,
  type DoomOverlayChrome,
  type DoomOverlayTui,
} from './doomOverlay.ts';
import { fitStyledLine } from './rendering.ts';

type Row = { kind: 'source'; source: ToolSource } | { kind: 'tool'; source: ToolSource; tool: ToolEntry };

const TITLE = 'TOOLS';
const BREADCRUMB = 'SPC › e / t · tools';
const HEADER_RIGHT = 'esc close';
const HINTS: readonly (readonly [string, string])[] = [
  ['↑↓', 'move'],
  ['esc', 'close'],
];

const MIN_WIDTH = 48;
/** A third for the tree, two thirds for the tool being read. */
const TREE_PANE_RATIO = 1 / 3;
/** One blank column each side of the pane divider so neither column touches it. */
const PANE_GUTTER = 1;
const MIN_PANE_WIDTH = 18;
const ELLIPSIS = '…';
const TOOL_INDENT = '   ';
const LABEL_COLUMN = 12;
const REQUIRED_MARKER = ' *';
const EMPTY_MESSAGE = 'No tools are registered in this session.';
const ACTIVE_LABEL = 'active';
const INACTIVE_LABEL = 'inactive';
const SOURCE_HEADING = 'SOURCES';

function fitRow(text: string, width: number): string {
  return fitStyledLine(text, width, ELLIPSIS);
}

function rightAligned(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  return fitRow(left, leftWidth) + ' '.repeat(Math.max(1, width - leftWidth - rightWidth)) + fitRow(right, rightWidth);
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

/** Top-level properties of a JSON-schema-shaped parameter object, if it has any. */
function parameterRows(parameters: unknown): readonly { name: string; type: string; required: boolean }[] {
  if (typeof parameters !== 'object' || parameters === null) return [];
  const schema = parameters as { properties?: unknown; required?: unknown };
  if (typeof schema.properties !== 'object' || schema.properties === null) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === 'string') : [],
  );
  return Object.entries(schema.properties as Record<string, unknown>).map(([name, value]) => {
    const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined;
    return {
      name,
      type: typeof type === 'string' ? type : '',
      required: required.has(name),
    };
  });
}

function activeCount(source: ToolSource): number {
  return source.tools.reduce((total, tool) => total + (tool.active ? 1 : 0), 0);
}

export class ToolsOverlayComponent extends DoomOverlay {
  private readonly sources: readonly ToolSource[];
  private readonly done: (result: undefined) => void;
  private selected: number;
  private bodyHeight = 1;

  constructor(tui: DoomOverlayTui, theme: Theme, sources: readonly ToolSource[], done: (result: undefined) => void) {
    super(tui, theme);
    this.sources = sources;
    this.done = done;
    this.selected = this.rows().findIndex((row) => row.kind === 'tool');
  }

  /** Every source is always expanded: the source row is a heading, not a control. */
  private rows(): readonly Row[] {
    const rows: Row[] = [];
    for (const source of this.sources) {
      rows.push({ kind: 'source', source });
      for (const tool of source.tools) rows.push({ kind: 'tool', source, tool });
    }
    return rows;
  }

  private currentTool(): Extract<Row, { kind: 'tool' }> | undefined {
    const row = this.rows()[this.selected];
    return row?.kind === 'tool' ? row : undefined;
  }

  /** Source rows are labels, so the cursor steps over them to the next tool. */
  private move(delta: number): void {
    const rows = this.rows();
    const step = delta < 0 ? -1 : 1;
    let index = this.selected;
    for (let remaining = Math.abs(delta); remaining > 0; remaining -= 1) {
      let next = index + step;
      while (next >= 0 && next < rows.length && rows[next]?.kind !== 'tool') next += step;
      if (next < 0 || next >= rows.length) break;
      index = next;
    }
    if (index === this.selected) return;
    this.selected = index;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || data === 'q') {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down') || data === 'j') {
      this.move(1);
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.move(-Math.max(1, this.bodyHeight - 1));
      return;
    }
    if (matchesKey(data, 'pageDown')) this.move(Math.max(1, this.bodyHeight - 1));
  }

  private treeLines(width: number): string[] {
    const rows = this.rows();
    const lines = [this.theme.bold(SOURCE_HEADING), ''];
    if (rows.length === 0) {
      lines.push(this.theme.fg('dim', EMPTY_MESSAGE));
      return lines;
    }

    const budget = Math.max(1, this.bodyHeight - lines.length);
    const selected = Math.max(0, Math.min(this.selected, rows.length - 1));
    const start = Math.max(0, Math.min(selected - budget + 1, Math.max(0, rows.length - budget)));
    for (const [offset, row] of rows.slice(start, start + budget).entries()) {
      const line =
        row.kind === 'source'
          ? rightAligned(
              this.theme.bold(row.source.label),
              this.theme.fg('dim', row.source.status ?? String(activeCount(row.source))),
              width,
            )
          : // Colour separates the active tool set from the merely registered one,
            // so the cursor never has to visit a row to learn its state.
            this.theme.fg(row.tool.active ? 'text' : 'dim', fitRow(`${TOOL_INDENT}${row.tool.name}`, width));
      lines.push(start + offset === selected ? this.theme.bg('selectedBg', fitRow(line, width)) : line);
    }
    return lines;
  }

  private field(label: string, value: string, width: number): string[] {
    const valueWidth = Math.max(1, width - LABEL_COLUMN);
    return wrap(value, valueWidth).map(
      (line, index) =>
        `${this.theme.fg('dim', fitRow(index === 0 ? label : '', LABEL_COLUMN))}${fitRow(line, valueWidth)}`,
    );
  }

  private toolLines(source: ToolSource, tool: ToolEntry, width: number): string[] {
    const lines = [this.theme.bold(tool.name), ''];
    lines.push(...this.field('source', source.label, width));
    // Source rows no longer open a detail pane, so the entry path is shown here.
    if (source.detail) lines.push(...this.field('registered', source.detail, width));
    lines.push(
      ...this.field(
        'status',
        tool.active ? this.theme.fg('success', ACTIVE_LABEL) : this.theme.fg('dim', INACTIVE_LABEL),
        width,
      ),
    );
    if (tool.description) {
      lines.push('');
      lines.push(...wrap(tool.description, width));
    }
    const parameters = parameterRows(tool.parameters);
    if (parameters.length > 0) {
      lines.push('');
      lines.push(this.theme.fg('dim', 'PARAMETERS'));
      for (const parameter of parameters) {
        // The name takes the whole line so long ones stop truncating into the
        // type, which sits flush right where the eye can run down the column.
        const name = parameter.required
          ? `${parameter.name}${this.theme.fg('warning', REQUIRED_MARKER)}`
          : parameter.name;
        lines.push(rightAligned(name, this.theme.fg('dim', parameter.type), width));
      }
    }
    for (const guideline of tool.promptGuidelines ?? []) {
      lines.push('');
      lines.push(...wrap(guideline, width));
    }
    return lines;
  }

  private detailLines(width: number): string[] {
    const row = this.currentTool();
    if (!row) return [this.theme.fg('dim', EMPTY_MESSAGE)];
    return this.toolLines(row.source, row.tool, width);
  }

  protected getChrome(): DoomOverlayChrome {
    // Active over registered: the first number is what the model can call, the
    // second is what a different mode or profile could turn back on.
    const active = this.sources.reduce((total, source) => total + activeCount(source), 0);
    const tools = `${active}/${this.sources.reduce((total, source) => total + source.tools.length, 0)}`;
    return {
      title: TITLE,
      accent: DOOM_OVERLAY_ACCENT,
      breadcrumb: BREADCRUMB,
      headerRight: `${tools} tools · ${this.sources.length} sources · ${HEADER_RIGHT}`,
      footer: this.hintLine(),
    };
  }

  private hintLine(): string {
    return HINTS.map(
      ([key, label]) =>
        `${this.theme.bg('selectedBg', this.theme.fg('text', ` ${key} `))}${this.theme.fg('dim', ` ${label}`)}`,
    ).join(this.theme.fg('dim', '   '));
  }

  protected renderBody(width: number, height: number): string[] {
    this.bodyHeight = height;
    if (width < MIN_WIDTH) return this.renderStacked(width, height);

    const leftWidth = Math.max(MIN_PANE_WIDTH, Math.floor((width - 1) * TREE_PANE_RATIO));
    const rightWidth = Math.max(1, width - leftWidth - 1);
    const leftContent = Math.max(1, leftWidth - PANE_GUTTER);
    const rightContent = Math.max(1, rightWidth - PANE_GUTTER);
    const left = this.treeLines(leftContent);
    const right = this.detailLines(rightContent);

    const divider = this.theme.fg('borderMuted', '│');
    return Array.from({ length: height }, (_, index) => {
      const row = `${fitRow(left[index] ?? '', leftContent)} ${divider} ${fitRow(right[index] ?? '', rightContent)}`;
      return truncateToWidth(row, width, ELLIPSIS);
    });
  }

  private renderStacked(width: number, height: number): string[] {
    const topHeight = Math.max(1, Math.floor((height - 1) / 2));
    const bottomHeight = Math.max(0, height - topHeight - 1);
    this.bodyHeight = topHeight;
    const top = this.treeLines(width);
    const bottom = this.detailLines(width);
    return [
      ...top.slice(0, topHeight),
      ...Array.from({ length: Math.max(0, topHeight - top.length) }, () => ''),
      this.theme.fg('borderMuted', '─'.repeat(width)),
      ...bottom.slice(0, bottomHeight),
    ];
  }
}

export async function openToolsOverlay(ctx: ExtensionContext, sources: readonly ToolSource[]): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new ToolsOverlayComponent(tui, theme, sources, done),
    DOOM_FULLSCREEN_UI_OPTIONS,
  );
}
