import type { Theme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import {
  abbreviateHome,
  collapseCommand,
  formatBashFlags,
  formatResultSummary,
  renderBashCall,
  renderBashResult,
  truncateMiddle,
} from '../../src/tui/bashRender';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  inverse: (text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function text(component: { render(width: number): string[] }, width = 200): string[] {
  return component
    .render(width)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^─+$/u.test(line));
}

const complete = { expanded: false, isPartial: false };

describe('public bash renderer', () => {
  it('formats command text and all optional flags', () => {
    expect(abbreviateHome('/home/me/a:/home/me/b', '/home/me')).toBe('~/a:~/b');
    expect(abbreviateHome('/home/me/a', '')).toBe('/home/me/a');
    expect(collapseCommand(' first\n\n second ')).toBe('first … +1 lines');
    expect(collapseCommand('')).toBe('');
    expect(truncateMiddle('short', 20)).toBe('short');
    expect(truncateMiddle('one two three four five six', 17)).toBe('one two … six');
    expect(formatBashFlags({ command: 'x' })).toEqual([]);
    expect(formatBashFlags({ command: 'x', background: true, interactive: true, timeout: 5, name: 'worker' })).toEqual([
      'bg',
      'tty',
      '5s',
      'worker',
    ]);
    expect(formatBashFlags({ command: 'x', name: '' })).toEqual([]);
  });

  it('renders calls with and without command flags', () => {
    const highlight = (code: string) => [code];
    expect(text(renderBashCall({ command: 'printf ok' }, theme, highlight))).toEqual(['BASH  printf ok']);
    expect(text(renderBashCall({ command: 'printf ok', background: true }, theme, highlight))).toEqual([
      'BASH  printf ok · bg',
    ]);
    expect(
      renderBashCall({ command: 'a very long command that wraps' }, theme, highlight).render(12).length,
    ).toBeGreaterThan(1);
  });

  it('renders bounded partial and error output, including error metadata', () => {
    const many = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const partial = text(
      renderBashResult(
        { content: [{ type: 'text', text: many }, { type: 'image' }] },
        { ...complete, isPartial: true },
        theme,
      ),
    );
    expect(partial[0]).toBe('line 8');
    expect(partial.at(-1)).toBe('◐ running');

    const error = text(
      renderBashResult(
        { content: [{ type: 'text', text: 'bad\n' }], details: { lines: 1, runner: 'api' } },
        { ...complete, isError: true },
        theme,
      ),
    );
    expect(error).toEqual(['bad', '✗ 1 lines · api']);
    expect(
      text(renderBashResult({ content: [{ type: 'text', text: 'bad' }] }, { ...complete, isError: true }, theme)),
    ).toEqual(['bad', '✗ failed']);
  });

  it('renders promoted runners with each available label fallback', () => {
    expect(text(renderBashResult({ details: { promoted: true, runner: 'api', id: 'r1' } }, complete, theme))).toEqual([
      '● api · r1 · background',
    ]);
    expect(text(renderBashResult({ details: { promoted: true, id: 'r2' } }, complete, theme))).toEqual([
      '● r2 · r2 · background',
    ]);
    expect(text(renderBashResult({ details: { promoted: true } }, complete, theme))).toEqual(['● runner · background']);
  });

  it('distinguishes success, failure, timeout, empty, collapsed, and expanded results', () => {
    const details = { exitCode: 0, tail: 'one\ntwo\n', tailLines: 2, lines: 2, fileSize: 100, runner: 'api' };
    expect(text(renderBashResult({ details }, complete, theme))).toEqual(['one', 'two', '✓ 2 lines · 100 B · api']);
    expect(text(renderBashResult({ details: { exitCode: 2, tail: '' } }, complete, theme))).toEqual(['✗ exit 2']);
    expect(text(renderBashResult({ details: { exitCode: 0, timedOut: true, tail: '' } }, complete, theme))).toEqual([
      '✗ timed out',
    ]);
    expect(text(renderBashResult({}, complete, theme))).toEqual(['✓ done']);

    const tail = Array.from({ length: 20 }, (_, index) => `item ${index}`).join('\n');
    const collapsed = text(renderBashResult({ details: { exitCode: 0, tail, tailLines: 20 } }, complete, theme));
    expect(collapsed[0]).toBe('item 8');
    expect(collapsed.at(-1)).toBe('✓ ctrl+o');
    const expanded = text(
      renderBashResult({ details: { exitCode: 0, tail, tailLines: 20 } }, { expanded: true, isPartial: false }, theme),
    );
    expect(expanded).toHaveLength(20);
  });

  it('preserves coloured output and handles non-positive widths', () => {
    const coloured = '\u001b[32mok\u001b[39m';
    expect(text(renderBashResult({ details: { exitCode: 0, tail: coloured } }, complete, theme))).toContain(coloured);
    expect(renderBashResult({}, complete, theme).render(0)).toEqual([]);
    expect(renderBashResult({}, complete, theme).render(-1)).toEqual([]);
    expect(formatResultSummary({ lines: 1 })).toBe('1 lines');
    expect(formatResultSummary({})).toBe('');
  });
});
