import { DoomToolCall, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

const COLLAPSED_RESULT_LINES = 12;
const MAX_ARGUMENTS = 3;
const ELLIPSIS = '…';

interface McpToolTextLayout {
  wrap: boolean;
  separator: boolean;
  trailingBlank: boolean;
}

/** Bash-compatible width budget, horizontal inset, and structural result divider. */
class McpToolText implements Component {
  constructor(
    private readonly lines: readonly string[],
    private readonly layout: McpToolTextLayout,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const contentWidth = Math.max(1, width - 2);
    const rendered = this.layout.wrap
      ? this.lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      : this.lines.map((line) => truncateToWidth(line, contentWidth, ELLIPSIS));
    if (this.layout.separator) {
      rendered.unshift(this.theme.fg('borderMuted', '─'.repeat(contentWidth)));
    }
    const padded = rendered.map((line) => ` ${line}`);
    if (this.layout.trailingBlank) padded.push('');
    return padded;
  }

  invalidate(): void {
    // Content is immutable and reflows from the current width on every render.
  }
}

function argumentValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length}]`;
  return '{…}';
}

function argumentSummary(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  const shown = entries.slice(0, MAX_ARGUMENTS).map(([key, value]) => `${key}=${argumentValue(value)}`);
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length}`);
  return shown.join(' · ');
}

export interface McpToolIdentity {
  serverName: string;
  toolName: string;
}

export function renderMcpCall(tool: McpToolIdentity, params: Record<string, unknown>, theme: Theme): Component {
  const heading = renderToolHeading('mcp', tool.serverName, theme, 'muted');
  const toolName = theme.fg('accent', tool.toolName);
  const argumentsText = argumentSummary(params);
  const text = `${heading}${theme.fg('muted', ' / ')}${toolName}${
    argumentsText ? ` ${theme.fg('muted', `· ${argumentsText}`)}` : ''
  }`;
  return new DoomToolCall(text);
}

export interface McpToolResultLike {
  content?: Array<{ type: string; text?: string }>;
}

export interface McpToolResultOptions {
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}

function resultLines(result: McpToolResultLike): string[] {
  const text = (result.content ?? []).map((block) => block.text ?? '').join('');
  const lines = text.split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines;
}

export function renderMcpResult(result: McpToolResultLike, options: McpToolResultOptions, theme: Theme): Component {
  const all = resultLines(result);
  const shown = options.expanded ? all : all.slice(0, COLLAPSED_RESULT_LINES);
  const body = shown.map((line) => theme.fg('toolOutput', line));

  if (options.isPartial) {
    body.push(theme.fg('warning', '◐') + theme.fg('dim', ' running'));
  } else if (options.isError) {
    body.push(theme.fg('error', '✗') + theme.fg('dim', ' failed'));
  } else if (!options.expanded && all.length > shown.length) {
    body.push(theme.fg('dim', '… ctrl+o'));
  } else if (body.length === 0) {
    body.push(theme.fg('success', '✓') + theme.fg('dim', ' done'));
  }

  return new McpToolText(body, { wrap: options.expanded, separator: true, trailingBlank: true }, theme);
}
