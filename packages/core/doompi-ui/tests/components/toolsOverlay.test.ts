import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { ToolsOverlayComponent } from '../../src/exports/components/toolsOverlay.ts';
import type { ToolSource } from '../../src/exports/toolInventory.ts';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

const SOURCES: readonly ToolSource[] = [
  {
    key: 'core',
    label: 'pi · core',
    kind: 'core',
    tools: [
      { name: 'bash', description: 'Run a shell command', active: true },
      { name: 'read', description: 'Read a file', active: false },
    ],
  },
  {
    key: 'mcp:code-intel',
    label: 'code-intel · mcp',
    kind: 'mcp',
    status: 'disabled',
    tools: [
      {
        name: 'code_intel_get_diagnostics',
        description: 'Report diagnostics for a file',
        parameters: { properties: { path: { type: 'string' }, limit: { type: 'number' } }, required: ['path'] },
        active: false,
      },
    ],
  },
];

function createOverlay(sources: readonly ToolSource[] = SOURCES) {
  const tui = { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() };
  const done = vi.fn();
  return { overlay: new ToolsOverlayComponent(tui, theme, sources, done), done, tui };
}

describe('ToolsOverlayComponent', () => {
  it('lists every source expanded, with active counts and no expansion markers', () => {
    const { overlay } = createOverlay();

    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('TOOLS');
    // One of the three registered tools is active; the disabled server shows its state instead of a count.
    expect(rendered).toContain('1/3 tools · 2 sources');
    expect(rendered).toContain('pi · core');
    expect(rendered).toContain('code-intel · mcp');
    expect(rendered).toContain('disabled');
    expect(rendered).not.toContain('▾');
    expect(rendered).not.toContain('▸');
    // Nothing starts collapsed, so every tool is visible without navigating.
    expect(rendered).toContain('bash');
    expect(rendered).toContain('read');
    expect(rendered).toContain('code_intel_get_diagnostics');
  });

  it('opens on the first tool rather than its heading', () => {
    const { overlay } = createOverlay();

    const rendered = overlay.render(120).join('\n');
    expect(rendered).toContain('source      pi · core');
    expect(rendered).toContain('status      active');
    expect(rendered).toContain('Run a shell command');
  });

  it('steps over source headings when moving between tools', () => {
    const { overlay } = createOverlay();

    // bash -> read, then over the `code-intel · mcp` heading onto its only tool.
    overlay.handleInput('j');
    expect(overlay.render(120).join('\n')).toContain('Read a file');
    overlay.handleInput('j');
    const rendered = overlay.render(120).join('\n');

    expect(rendered).toContain('Report diagnostics for a file');
    expect(rendered).toContain('status      inactive');
    // The last tool is the end of the list; there is no heading to land on.
    overlay.handleInput('j');
    expect(overlay.render(120).join('\n')).toContain('Report diagnostics for a file');
  });

  it('marks required parameters and right-aligns their type', () => {
    const { overlay } = createOverlay();

    overlay.handleInput('j');
    overlay.handleInput('j');
    const line = overlay.render(120).find((row) => row.includes('path'));

    // The type is flush against the right edge of the detail pane, past the frame border.
    expect(line).toMatch(/path \*\s{2,}string\s*│$/);
  });

  it('stacks the panes on a narrow terminal', () => {
    const { overlay } = createOverlay();

    const lines = overlay.render(40);
    expect(lines).toHaveLength(24);
    expect(lines.join('\n')).toContain('─'.repeat(30));
  });

  it('reports an empty session and closes on escape', () => {
    const { overlay, done } = createOverlay([]);

    expect(overlay.render(120).join('\n')).toContain('No tools are registered');
    overlay.handleInput('');
    expect(done).toHaveBeenCalledWith(undefined);
  });
});
