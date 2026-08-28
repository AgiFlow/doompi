import type { AgentToolResult, Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { renderHashlineCall, renderHashlineEditResult, renderHashlineResult } from '../src/tui/hashlineRendering.ts';

function plainTheme(): Theme {
  const identity = (value: string): string => value;
  return {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
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
  theme.fg = (color: string, value: string) => `<${color}>${value}</${color}>`;
  theme.bg = (color: string, value: string) => `<bg:${color}>${value}</bg:${color}>`;
  return theme;
}

function result(text: string, diff?: string): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details: diff === undefined ? undefined : { diff } };
}

function rendered(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => line.trimEnd());
}

function stripKnownThemeMarkers(line: string): string {
  let plain = line;
  for (const marker of ['borderMuted', 'typescript', 'dim', 'muted']) {
    plain = plain.replaceAll(`<${marker}>`, '').replaceAll(`</${marker}>`, '');
  }
  return plain;
}
describe('hashline tool rendering', () => {
  it('uses standard Doom badges and compact details', () => {
    const theme = plainTheme();
    expect(rendered(renderHashlineCall('read', 'a.ts', ['from 2', '10 lines'], theme)).join('\n')).toContain(
      ' READ  a.ts · from 2 · 10 lines',
    );
    expect(rendered(renderHashlineCall('grep', 'TODO', ['src', 'ignore case'], theme)).join('\n')).toContain(
      ' GREP  TODO · src · ignore case',
    );
    expect(rendered(renderHashlineCall('edit', 'a.ts', ['1 range'], theme)).join('\n')).toContain(
      ' EDIT  a.ts · 1 range',
    );
  });

  it('hides agent-only hashes while preserving syntax highlighting and continuation UI', () => {
    const output = [
      '@file a.ts#abcdefgh',
      ...Array.from({ length: 20 }, (_, index) => `${index + 1}#abc|line ${index + 1}`),
      '',
      '[10 more lines in file. Use offset=21 to continue.]',
    ].join('\n');
    const component = renderHashlineResult(
      result(output),
      { expanded: false, isPartial: false },
      markingTheme(),
      { isError: false },
      'read',
      (code, language) => code.split('\n').map((line) => `<${language}>${line}</${language}>`),
      () => 'typescript',
    );
    const lines = rendered(component, 80);

    expect(lines[0]).toContain('<borderMuted>');
    expect(lines.join('\n')).not.toContain('@file');
    expect(lines.join('\n')).not.toContain('abcdefgh');
    expect(lines.join('\n')).not.toContain('#abc|');
    expect(lines.join('\n')).toContain('<typescript>line 1</typescript>');
    expect(lines.join('\n')).toContain('<dim>… 10 more lines · ctrl+o expand</dim>');
    expect(lines.join('\n')).toContain('<muted>[10 more lines in file. Use offset=21 to continue.]</muted>');
    expect(lines.at(-1)).toBe('');
    expect(lines.every((line) => visibleWidth(stripKnownThemeMarkers(line)) <= 80)).toBe(true);
  });

  it('keeps grep grouping and match context while hiding hashes', () => {
    const output = [
      '@file src/a.ts#abcdefgh',
      '>> 12#abc|matched',
      '   13#def|context',
      '@file src/b.json#ijklmnop',
      '>> 2#ghi|second',
    ].join('\n');
    const lines = rendered(
      renderHashlineResult(
        result(output),
        { expanded: false, isPartial: false },
        markingTheme(),
        { isError: false },
        'grep',
        (code, language) => code.split('\n').map((line) => `<${language}>${line}</${language}>`),
        (path) => (path.endsWith('.ts') ? 'typescript' : 'json'),
      ),
      120,
    ).join('\n');

    expect(lines).toContain('<muted>src/a.ts</muted>');
    expect(lines).toContain('<accent>>></accent>');
    expect(lines).toContain('<dim>12</dim> <typescript>matched</typescript>');
    expect(lines).toContain('   <dim>13</dim> <typescript>context</typescript>');
    expect(lines).toContain('<json>second</json>');
    expect(lines).not.toContain('@file');
    expect(lines).not.toMatch(/#[a-z]{3}\|/u);
    expect(lines).not.toContain('abcdefgh');
  });

  it('keeps read and grep collapse limits distinct', () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const theme = plainTheme();
    const read = rendered(
      renderHashlineResult(result(output), { expanded: false, isPartial: false }, theme, { isError: false }, 'read'),
    );
    const grep = rendered(
      renderHashlineResult(result(output), { expanded: false, isPartial: false }, theme, { isError: false }, 'grep'),
    );
    expect(read.join('\n')).toContain('… 10 more lines · ctrl+o expand');
    expect(grep.join('\n')).toContain('… 5 more lines · ctrl+o expand');
  });

  it('keeps syntax highlighting for native non-hashline read output', () => {
    const lines = rendered(
      renderHashlineResult(
        result('const answer = 42;\nanswer;'),
        { expanded: false, isPartial: false },
        markingTheme(),
        { args: { path: 'readonly.ts' }, isError: false },
        'read',
        (code, language) => code.split('\n').map((line) => `<${language}>${line}</${language}>`),
        () => 'typescript',
      ),
    ).join('\n');

    expect(lines).toContain('<typescript>const answer = 42;</typescript>');
    expect(lines).toContain('<typescript>answer;</typescript>');
  });

  it('renders errors and successful edit diffs with established styling', () => {
    const theme = markingTheme();
    const message = 'Invalid line anchor: LINE#wjs. Expected one anchor such as 5#abc.';
    const failure = rendered(
      renderHashlineResult(result(message), { expanded: false, isPartial: false }, theme, { isError: true }, 'plain'),
      160,
    ).join('\n');
    expect(failure).toContain(`<error>${message}</error>`);

    const diff = [' 1 before', '-2 old', '+2 new'].join('\n');
    const success = renderHashlineEditResult(
      'a.ts',
      result('Edited a.ts.', diff),
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    ).render(160);
    expect(success[0]).toContain('<borderMuted>');
    expect(success[2]).toContain('<bg:toolErrorBg>');
    expect(success[3]).toContain('<bg:toolSuccessBg>');
  });
});
