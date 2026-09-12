import type { SubagentToolParams } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import { DoomToolCall, renderToolHeading } from '@agimon-ai/doompi-ui/toolChrome';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import { type Component, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

const COLLAPSED_RESULT_LINES = 12;
const ELLIPSIS = '…';

interface SubagentToolTextLayout {
  wrap: boolean;
  frameColor?: ThemeColor;
  trailingBlank?: boolean;
}

/** Width-aware text for the self-owned subagent tool shell. */
class SubagentToolText implements Component {
  constructor(
    private readonly lines: readonly string[],
    private readonly layout: SubagentToolTextLayout,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 3) return this.lines.map((line) => truncateToWidth(line, width, ELLIPSIS));

    const contentWidth = width - 2;
    const rendered = this.layout.wrap
      ? this.lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      : this.lines.map((line) => truncateToWidth(line, contentWidth, ELLIPSIS));
    if (this.layout.frameColor) {
      rendered.unshift(this.theme.fg(this.layout.frameColor, '─'.repeat(contentWidth)));
    }
    const padded = rendered.map((line) => ` ${line}`);
    if (this.layout.trailingBlank) padded.push('');
    return padded;
  }

  invalidate(): void {
    // The host rebuilds tool renderers when the theme changes.
  }
}

function callDetails(params: SubagentToolParams, theme: Theme): string {
  switch (params.action) {
    case 'agents':
      return params.name ? theme.fg('accent', params.name) : '';
    case 'run': {
      const agents = params.requests.map((request) => request.agent);
      const count = `${agents.length} agent${agents.length === 1 ? '' : 's'}`;
      return theme.fg('muted', `${count} · ${agents.join(', ')}`);
    }
    case 'status':
      return theme.fg('accent', 'id' in params ? params.id : 'fleet');
    case 'steer':
    case 'stop':
    case 'restore':
      return theme.fg('accent', params.id);
    case 'suspended':
      return theme.fg('muted', 'runs');
  }
}

export function renderSubagentCall(params: SubagentToolParams, theme: Theme): Component {
  const heading = renderToolHeading('subagent', params.action, theme);
  const detail = callDetails(params, theme);
  return new DoomToolCall(`${heading}${detail ? ` ${detail}` : ''}`);
}

export interface SubagentResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

export interface SubagentResultOptions {
  expanded: boolean;
  isPartial: boolean;
}

function contentLines(result: SubagentResultLike): string[] {
  const text = (result.content ?? []).map((block) => block.text ?? '').join('');
  const lines = text.split('\n');
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines;
}

function framedResult(lines: readonly string[], wrap: boolean, theme: Theme): Component {
  return new SubagentToolText(lines, { wrap, frameColor: 'borderMuted', trailingBlank: true }, theme);
}

export function renderSubagentResult(
  result: SubagentResultLike,
  options: SubagentResultOptions,
  theme: Theme,
): Component {
  const all = contentLines(result);
  if (options.isPartial) {
    const body = all.slice(-COLLAPSED_RESULT_LINES).map((line) => theme.fg('toolOutput', line));
    return framedResult([...body, theme.fg('warning', '◐') + theme.fg('dim', ' running')], false, theme);
  }

  const failed = result.isError === true;
  const shown = options.expanded ? all : all.slice(0, COLLAPSED_RESULT_LINES);
  const body = shown.map((line) => theme.fg('toolOutput', line));
  if (failed) {
    body.push(theme.fg('error', '✗') + theme.fg('dim', ' failed'));
  } else if (!options.expanded && all.length > shown.length) {
    body.push(theme.fg('dim', '… ctrl+o'));
  } else if (body.length === 0) {
    body.push(theme.fg('success', '✓') + theme.fg('dim', ' done'));
  }
  return framedResult(body, options.expanded, theme);
}
