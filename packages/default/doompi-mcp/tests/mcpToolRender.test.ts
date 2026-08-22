import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { renderMcpCall, renderMcpResult } from '../src/tui/mcpToolRender.ts';

function plainTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_color: string, text: string) => text,
    bold: identity,
    inverse: identity,
    dim: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
  } as unknown as Theme;
}

function markingTheme(): Theme {
  const theme = plainTheme();
  theme.fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
  return theme;
}

function contentLines(component: { render(width: number): string[] }, width = 80): string[] {
  const lines = component
    .render(width)
    .map((line) => line.trimEnd())
    .map((line) => (line.startsWith(' ') ? line.slice(1) : line));
  if (/^─+$/.test(lines[0] ?? '')) lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

const tool = { serverName: 'pencil', toolName: 'get_screenshot' };

describe('MCP tool rendering', () => {
  it('uses a padded Doom badge with compact server, tool, and argument details', () => {
    const component = renderMcpCall(tool, { scale: 2, nested: { value: true }, pages: [1, 2] }, plainTheme());
    const rendered = component.render(80);

    expect(rendered[0]).toMatch(/^ {2}MCP /);
    expect(rendered.join(' ')).toContain(' MCP  pencil / get_screenshot · scale=2 · nested={…} · pages=[2]');
  });

  it('bounds collapsed output and uses the bash-style neutral separator', () => {
    const output = Array.from({ length: 30 }, (_, index) => `result ${index} with a long value`).join('\n');
    const result = { content: [{ type: 'text', text: output }] };
    const options = { expanded: false, isPartial: false, isError: false };
    const rendered = renderMcpResult(result, options, plainTheme()).render(24);
    const decorated = renderMcpResult(result, options, markingTheme()).render(24);

    expect(decorated[0]).toContain('<borderMuted>');
    expect(rendered.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(contentLines({ render: () => rendered }, 24).at(-1)).toContain('ctrl+o');
    expect(rendered.at(-1)).toBe('');
  });

  it('keeps semantic lifecycle colors in summaries instead of the separator', () => {
    const theme = markingTheme();
    const pending = renderMcpResult(
      { content: [{ type: 'text', text: 'connecting' }] },
      { expanded: false, isPartial: true, isError: false },
      theme,
    ).render(40);
    const failed = renderMcpResult(
      { content: [{ type: 'text', text: 'unavailable' }] },
      { expanded: false, isPartial: false, isError: true },
      theme,
    ).render(40);
    const success = contentLines(
      renderMcpResult(
        { content: [{ type: 'text', text: 'captured' }] },
        { expanded: false, isPartial: false, isError: false },
        theme,
      ),
    );

    expect(pending[0]).toContain('<borderMuted>');
    expect(pending.join('\n')).toContain('<warning>◐</warning>');
    expect(failed[0]).toContain('<borderMuted>');
    expect(failed.join('\n')).toContain('<error>✗</error>');
    expect(success.at(-1)).toBe('<toolOutput>captured</toolOutput>');
    expect(success.join('\n')).not.toContain('✓');
  });

  it('labels an empty successful result', () => {
    expect(
      contentLines(renderMcpResult({}, { expanded: false, isPartial: false, isError: false }, plainTheme())),
    ).toEqual(['✓ done']);
  });
});
