import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { renderSubagentCall, renderSubagentResult } from '../../src/adapters/pi/tui/subagentToolRender';

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

describe('subagent tool rendering', () => {
  it('uses a Doom badge and action-aware call summary', () => {
    const rendered = contentLines(
      renderSubagentCall(
        {
          action: 'run',
          requests: [
            { agent: 'researcher', task: 'inspect' },
            { agent: 'reviewer', task: 'review' },
          ],
        },
        plainTheme(),
      ),
    );

    expect(rendered.join(' ')).toContain(' SUBAGENT  run 2 agents · researcher, reviewer');
  });

  it.each([
    [{ action: 'agents' as const }, ' SUBAGENT  agents'],
    [{ action: 'agents' as const, name: 'researcher' }, ' SUBAGENT  agents researcher'],
    [{ action: 'run' as const, requests: [{ agent: 'worker', task: 'work' }] }, ' SUBAGENT  run 1 agent · worker'],
    [{ action: 'status' as const }, ' SUBAGENT  status fleet'],
    [{ action: 'status' as const, id: 'run-1' }, ' SUBAGENT  status run-1'],
    [{ action: 'steer' as const, id: 'run-1', message: 'continue' }, ' SUBAGENT  steer run-1'],
    [{ action: 'stop' as const, id: 'run-1' }, ' SUBAGENT  stop run-1'],
    [{ action: 'restore' as const, id: 'run-1' }, ' SUBAGENT  restore run-1'],
    [{ action: 'suspended' as const }, ' SUBAGENT  suspended runs'],
  ])('summarizes %# without raw argument noise', (params, expected) => {
    expect(contentLines(renderSubagentCall(params, plainTheme())).join(' ')).toContain(expected);
  });

  it('uses the bash-style neutral divider for every lifecycle state', () => {
    const theme = markingTheme();
    const pending = renderSubagentResult(
      { content: [{ type: 'text', text: 'Starting...' }] },
      { expanded: false, isPartial: true },
      theme,
    ).render(30);
    const success = renderSubagentResult(
      { content: [{ type: 'text', text: 'Started.' }] },
      { expanded: false, isPartial: false },
      theme,
    ).render(30);
    const failure = renderSubagentResult(
      { content: [{ type: 'text', text: 'Unavailable.' }], isError: true },
      { expanded: false, isPartial: false },
      theme,
    ).render(30);

    expect(pending[0]).toContain('<borderMuted>');
    expect(success[0]).toContain('<borderMuted>');
    expect(failure[0]).toContain('<borderMuted>');
    expect(pending.at(-1)).toBe('');
    expect(success.at(-1)).toBe('');
    expect(failure.at(-1)).toBe('');
  });

  it('bounds collapsed output and keeps every rendered line within the viewport', () => {
    const output = Array.from({ length: 30 }, (_, index) => `agent ${index} with a long status`).join('\n');
    const rendered = renderSubagentResult(
      { content: [{ type: 'text', text: output }] },
      { expanded: false, isPartial: false },
      plainTheme(),
    ).render(24);

    expect(rendered).toHaveLength(15);
    expect(rendered.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(contentLines({ render: () => rendered }, 24).at(-1)).toBe('… ctrl+o');
  });

  it('does not append a redundant bare success check after normal output', () => {
    const rendered = contentLines(
      renderSubagentResult(
        { content: [{ type: 'text', text: 'Executable agents:\n- worker' }] },
        { expanded: false, isPartial: false },
        plainTheme(),
      ),
    );

    expect(rendered).toEqual(['Executable agents:', '- worker']);
  });

  it('labels empty success and failure summaries instead of rendering bare glyphs', () => {
    const empty = contentLines(renderSubagentResult({}, { expanded: false, isPartial: false }, plainTheme()));
    const failed = contentLines(
      renderSubagentResult(
        { content: [{ type: 'text', text: 'unavailable' }], isError: true },
        { expanded: true, isPartial: false },
        plainTheme(),
      ),
    );

    expect(empty).toEqual(['✓ done']);
    expect(failed.at(-1)).toBe('✗ failed');
  });
});
