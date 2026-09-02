import { describe, expect, it } from 'vitest';
import { ansiSpans } from '../../src/lib/ansiSpans.ts';

const ESC = '\x1b';

describe('ansiSpans', () => {
  it('reads a plain line as one span', () => {
    expect(ansiSpans('pnpm nx run-many -t test')).toEqual([{ text: 'pnpm nx run-many -t test' }]);
  });

  // The named colours become theme tokens so a run's output sits in the
  // cockpit's palette rather than fighting it.
  it('maps a named colour to a theme token', () => {
    expect(ansiSpans(`${ESC}[32m42 passed${ESC}[0m`)).toEqual([{ text: '42 passed', className: 'text-doom-green' }]);
  });

  it('keeps the attributes in force across a line', () => {
    const spans = ansiSpans(`plain ${ESC}[1;31mfailed${ESC}[0m after`);
    expect(spans).toEqual([
      { text: 'plain ' },
      { text: 'failed', className: 'text-doom-red', bold: true },
      { text: ' after' },
    ]);
  });

  // Truecolour and the 256 palette name a colour no token stands for, so they
  // are rendered as themselves.
  it('renders truecolour as an exact colour', () => {
    expect(ansiSpans(`${ESC}[38;2;255;108;107mred${ESC}[0m`)).toEqual([{ text: 'red', color: 'rgb(255 108 107)' }]);
  });

  it('renders a palette entry as an exact colour', () => {
    expect(ansiSpans(`${ESC}[38;5;196mbright${ESC}[0m`)).toEqual([{ text: 'bright', color: 'rgb(255 0 0)' }]);
  });

  // A child painting its own background over the cockpit's panel is what makes
  // captured output unreadable in a theme.
  it('drops a background colour', () => {
    expect(ansiSpans(`${ESC}[41mred bg${ESC}[0m`)).toEqual([{ text: 'red bg' }]);
  });

  // A cursor move that arrived as visible junk would be worse than one that
  // arrived as nothing: the next capture repaints the screen anyway.
  it('drops sequences that are not colour', () => {
    expect(ansiSpans(`${ESC}[2K${ESC}[1;1Hclean`)).toEqual([{ text: 'clean' }]);
  });

  it('resets on a bare escape with no parameters', () => {
    const spans = ansiSpans(`${ESC}[1mbold${ESC}[mplain`);
    expect(spans).toEqual([{ text: 'bold', bold: true }, { text: 'plain' }]);
  });

  it('reads an empty line as no spans', () => {
    expect(ansiSpans('')).toEqual([]);
  });
});
