import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import {
  type EditToolResult,
  frameBuiltinResult,
  previousBuiltinResult,
  renderEditCall,
  renderEditResult,
  renderFindCall,
  renderGrepCall,
  renderLsCall,
  renderReadCall,
  renderReadResult,
  renderWriteCall,
} from '../../src/tui/builtinToolRender.ts';

function plainTheme(): Theme {
  const identity = (text: string): string => text;
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
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
  theme.bg = (color: string, text: string) => `<bg:${color}>${text}</bg:${color}>`;
  return theme;
}

function rendered(component: { render(width: number): string[] }): string {
  return component.render(120).join('\n');
}

describe('built-in tool call rendering', () => {
  const theme = plainTheme();

  it('uses bracketed labels, bash-compatible padding, and compact operation details', () => {
    expect(rendered(renderReadCall({ path: 'src/index.ts', offset: 10, limit: 20 }, theme))).toContain(
      ' READ  src/index.ts · from 10 · 20 lines',
    );
    expect(
      rendered(renderEditCall({ path: 'src/index.ts', edits: [{ oldText: 'old', newText: 'new' }] }, theme)),
    ).toContain(' EDIT  src/index.ts · 1 edit');
    expect(rendered(renderWriteCall({ path: 'out.txt', content: 'hello' }, theme))).toContain(
      ' WRITE  out.txt · 5 chars',
    );
    expect(rendered(renderGrepCall({ pattern: 'TODO', path: 'src', ignoreCase: true }, theme))).toContain(
      ' GREP  TODO · src · ignore case',
    );
    expect(rendered(renderFindCall({ pattern: '*.ts' }, theme))).toContain(' FIND  *.ts · .');
    expect(rendered(renderLsCall({}, theme))).toContain(' LS  .');
    expect(renderReadCall({ path: 'src/index.ts' }, theme).render(40)[0]).toMatch(/^ {2}READ /);
  });

  it('shows syntax-highlighted write content with collapsed and expanded previews', () => {
    const content = Array.from({ length: 12 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const highlight = (code: string, language?: string): string[] =>
      code.split('\n').map((line) => `<${language}>${line}</${language}>`);
    const resolveLanguage = (): string => 'typescript';

    const collapsed = rendered(
      renderWriteCall({ path: 'src/output.ts', content }, theme, {}, highlight, resolveLanguage),
    );
    expect(collapsed).toContain('<typescript>const value0 = 0;</typescript>');
    expect(collapsed).not.toContain('const value10 = 10;');
    expect(collapsed).toContain('… 2 more lines · ctrl+o expand');

    const expanded = rendered(
      renderWriteCall({ path: 'src/output.ts', content }, theme, { expanded: true }, highlight, resolveLanguage),
    );
    expect(expanded).toContain('<typescript>const value11 = 11;</typescript>');
    expect(expanded).not.toContain('ctrl+o expand');
  });

  it('keeps a live tail visible while long write arguments stream, then settles on the file head', () => {
    const content = Array.from({ length: 12 }, (_, index) => `line-${index.toString().padStart(2, '0')}`).join('\n');

    const streaming = rendered(renderWriteCall({ path: 'out.txt', content }, theme, { argsStreaming: true }));
    expect(streaming).not.toContain('line-00');
    expect(streaming).toContain('line-02');
    expect(streaming).toContain('line-11');
    expect(streaming).toContain('… 2 earlier lines · live tail');

    const complete = rendered(renderWriteCall({ path: 'out.txt', content }, theme, { argsStreaming: false }));
    expect(complete).toContain('line-00');
    expect(complete).toContain('line-09');
    expect(complete).not.toContain('line-10');
    expect(complete).toContain('… 2 more lines · ctrl+o expand');
  });

  it('numbers write preview lines, right-aligned, and follows the live tail offset', () => {
    const content = Array.from({ length: 12 }, (_, index) => `line-${index}`).join('\n');

    const collapsed = renderWriteCall({ path: 'out.txt', content }, theme).render(120);
    expect(collapsed[2]).toContain(' 1 line-0');
    expect(collapsed[11]).toContain('10 line-9');

    const tail = renderWriteCall({ path: 'out.txt', content }, theme, { argsStreaming: true }).render(120);
    expect(tail.at(-1)).toContain('12 line-11');
    expect(tail.at(-10)).toContain(' 3 line-2');
  });

  it('shows syntax-highlighted read content before expansion', () => {
    const content = Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index};`).join('\n');
    const highlight = (code: string, language?: string): string[] =>
      code.split('\n').map((line) => `<${language}>${line}</${language}>`);
    const component = renderReadResult(
      { path: 'src/input.ts' },
      { content: [{ type: 'text', text: content }] },
      {},
      theme,
      highlight,
      () => 'typescript',
    );
    const preview = rendered(component);

    expect(preview).toContain('<typescript>export const value0 = 0;</typescript>');
    expect(preview).not.toContain('value10');
    expect(preview).toContain('… 2 more lines · ctrl+o expand');
  });

  it('numbers read content from the requested offset and keeps the pagination note unnumbered', () => {
    const content = ['const a = 1;', 'const b = 2;', '', '[Showing lines 40-41 of 120. Use offset=42 to continue.]'];
    const preview = rendered(
      renderReadResult(
        { path: 'src/input.ts', offset: 40 },
        { content: [{ type: 'text', text: content.join('\n') }] },
        { expanded: true },
        theme,
        (code) => code.split('\n'),
        () => undefined,
      ),
    ).split('\n');

    expect(preview[0]).toBe('40 const a = 1;');
    expect(preview[1]).toBe('41 const b = 2;');
    expect(preview[2]).toBe('[Showing lines 40-41 of 120. Use offset=42 to continue.]');
  });
});

describe('edit diff rendering', () => {
  const theme = plainTheme();
  const args = { path: 'src/index.ts', edits: [{ oldText: 'old', newText: 'new' }] };
  const diff = [' 8 const before = 1;', '-9 const value = 1;', '+9 const value = 2;', ' 10 ...'].join('\n');
  // Pi's edit tool reports a display diff and a unified patch together. The
  // renderer only draws the diff, so the patch is filled in to satisfy the
  // contract rather than asserted on.
  const editResult = (details?: { diff: string }, text?: string): EditToolResult => ({
    content: text === undefined ? [] : [{ type: 'text', text }],
    details: details && { ...details, patch: `--- a/${args.path}\n+++ b/${args.path}\n${details.diff}` },
  });

  it('bands changed rows on the background and leaves the foreground to syntax highlighting', () => {
    const highlight = (code: string, language?: string): string[] =>
      code.split('\n').map((line) => `<${language}>${line}</${language}>`);
    const lines = renderEditResult(
      args,
      editResult({ diff }),
      {},
      markingTheme(),
      highlight,
      () => 'typescript',
      // The marking theme's tags count as visible width, so leave room for them.
    ).render(200);

    expect(lines[1]).toContain('<bg:toolErrorBg>');
    expect(lines[1]).toContain('<typescript>const value = 1;</typescript>');
    expect(lines[2]).toContain('<bg:toolSuccessBg>');
    expect(lines[2]).toContain('<toolDiffAdded>+</toolDiffAdded>');
    // Context rows stay unbanded so only the change carries a color.
    expect(lines[0]).not.toContain('<bg:');
  });

  it('pads every banded row to the full width so the color reaches the edge', () => {
    const [, removed] = renderEditResult(
      args,
      editResult({ diff }),
      {},
      theme,
      (code) => code.split('\n'),
      () => undefined,
    ).render(40);

    expect(removed).toHaveLength(40);
  });

  it('renders the error text instead of a diff, and nothing at all without details', () => {
    expect(
      renderEditResult(args, editResult(undefined, 'oldText not found'), { isError: true }, markingTheme()).render(40),
    ).toEqual(['<error>oldText not found</error>']);
    expect(renderEditResult(args, editResult(), {}, theme).render(40)).toEqual([]);
  });
});

describe('built-in tool result framing', () => {
  it('uses the bash-style divider and preserves the native inner component across updates', () => {
    const theme = markingTheme();
    const firstContent = new Text('first', 0, 0);
    const firstFrame = frameBuiltinResult(firstContent, theme, undefined);

    expect(firstFrame.render(20)[0]).toContain('<borderMuted>');
    expect(previousBuiltinResult(firstFrame)).toBe(firstContent);

    const nextContent = new Text('next', 0, 0);
    const nextFrame = frameBuiltinResult(nextContent, theme, firstFrame);
    expect(nextFrame).toBe(firstFrame);
    expect(previousBuiltinResult(nextFrame)).toBe(nextContent);
    expect(nextFrame.render(20).some((line) => line.includes('next'))).toBe(true);
    expect(nextFrame.render(20).at(-1)).toBe('');
  });
});
