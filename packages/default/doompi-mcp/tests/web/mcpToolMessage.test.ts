import { renderPlugin, toolMessagePropsFixture } from '@agimon-ai/doompi-core/webTesting';
import { describe, expect, it, vi } from 'vitest';

import { McpToolMessage } from '../../src/extensions/workspaces/sessions/(frontend)/tool/_components/McpToolMessage';

// The frame itself is exercised in the browser; this covers only where the card puts the result.
vi.mock('../../src/extensions/workspaces/sessions/(frontend)/tool/_components/McpInlineApp', () => ({
  McpInlineApp: () => null,
}));

const app = {
  version: 1,
  resourceUri: 'ui://fixture/standard.html',
  protocol: 'mcp',
  result: { content: [], structuredContent: { invocations: 1 } },
};

const render = (isError: boolean, details: Record<string, unknown> | null) =>
  renderPlugin(
    McpToolMessage,
    toolMessagePropsFixture({
      toolName: 'fixture_standard',
      result: { content: [{ type: 'text', text: 'public result' }], details },
      output: 'public result',
      isError,
    }).props,
  );

describe('MCP tool message collapse', () => {
  it('keeps a widget result behind the toggle', () => {
    const rendered = render(false, { server: 'fixture', tool: 'standard', app });
    expect(rendered.error).toBeUndefined();
    expect(rendered.html).toContain('aria-label="expand"');
    expect(rendered.html).not.toContain('tool-result-mcp');
    expect(rendered.includes('public result')).toBe(false);
  });

  it('always shows an error result beside its widget', () => {
    const rendered = render(true, { server: 'fixture', tool: 'standard', app });
    expect(rendered.html).toContain('tool-result-mcp');
    expect(rendered.includes('public result')).toBe(true);
  });

  it('shows a plain result without a toggle', () => {
    const rendered = render(false, null);
    expect(rendered.html).not.toContain('aria-label="expand"');
    expect(rendered.includes('public result')).toBe(true);
  });
});
