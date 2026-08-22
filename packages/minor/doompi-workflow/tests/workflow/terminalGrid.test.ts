import { describe, expect, it } from 'vitest';

import type { RenderGrid } from '../../src/schemas/workflowPi.ts';
import { renderGridLines, styleSequence } from '../../src/tui/workflow/terminalGrid';

const RESET = '\x1b[0m';

const STYLES = [
  { id: 0, foreground: '#FFFFFF', background: '#1E1E1E', foreground_source: 'default', background_source: 'default' },
  { id: 1, foreground: '#FF0000', foreground_source: 'rgb', background_source: 'default', bold: true },
  { id: 2, foreground: '#00FF00', foreground_source: 'palette', background: '#000080', background_source: 'rgb' },
];

function grid(overrides: Partial<RenderGrid> = {}): RenderGrid {
  return { styles: STYLES, row_spans: [], scrollback_spans: [], ...overrides } as RenderGrid;
}

describe('styleSequence', () => {
  it('emits nothing for a style that is the terminal default', () => {
    expect(styleSequence(STYLES[0])).toBe('');
    expect(styleSequence(undefined)).toBe('');
  });

  it('emits truecolour and attributes for an explicitly coloured style', () => {
    expect(styleSequence(STYLES[1])).toBe('\x1b[1;38;2;255;0;0m');
  });

  it('resolves a palette foreground through the same truecolour path as rgb', () => {
    expect(styleSequence(STYLES[2])).toBe('\x1b[38;2;0;255;0;48;2;0;0;128m');
  });
});

describe('renderGridLines', () => {
  it('lays spans back out at their columns and closes each styled span', () => {
    const lines = renderGridLines(
      grid({
        row_spans: [
          { row: 1, column: 0, text: 'ok', style_id: 1 },
          { row: 1, column: 4, text: 'done', style_id: 0 },
        ],
      }),
      10,
    );

    expect(lines).toEqual([`\x1b[1;38;2;255;0;0mok${RESET}  done`]);
  });

  it('keeps blank rows so the output is not rewrapped', () => {
    const lines = renderGridLines(
      grid({
        row_spans: [
          { row: 1, column: 0, text: 'first', style_id: 0 },
          { row: 3, column: 0, text: 'third', style_id: 0 },
        ],
      }),
      10,
    );

    expect(lines).toEqual(['first', '', 'third']);
  });

  it('puts scrollback before the viewport, since the two are separate row spaces', () => {
    const lines = renderGridLines(
      grid({
        scrollback_spans: [{ row: 7, column: 0, text: 'older', style_id: 0 }],
        row_spans: [{ row: 1, column: 0, text: 'newer', style_id: 0 }],
      }),
      10,
    );

    expect(lines).toEqual(['older', 'newer']);
  });

  it('drops trailing blank rows and keeps only the last requested lines', () => {
    const lines = renderGridLines(
      grid({
        row_spans: [
          { row: 1, column: 0, text: 'one', style_id: 0 },
          { row: 2, column: 0, text: 'two', style_id: 0 },
          { row: 3, column: 0, text: 'three', style_id: 0 },
          { row: 6, column: 0, text: '   ', style_id: 0 },
        ],
      }),
      2,
    );

    expect(lines).toEqual(['two', 'three']);
  });

  it('returns nothing for a grid with no spans at all', () => {
    expect(renderGridLines(grid(), 10)).toEqual([]);
  });
});
