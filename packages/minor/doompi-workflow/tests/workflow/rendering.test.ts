import { describe, expect, it } from 'vitest';
import {
  alignLine,
  fitLine,
  formatTokens,
  frameLine,
  packSegments,
  padLine,
} from '../../src/tui/workflow/rendering.ts';

/**
 * The width arithmetic every workflow overlay draws through.
 *
 * These run in a terminal whose width the user changes at will, so the edges
 * that matter are the degenerate ones: zero width, a width narrower than the
 * frame, and content wider than the space it was given.
 *
 * Assertions compare visible text. Truncation appends a colour reset, which is
 * an artifact of the underlying TUI helper rather than part of the contract.
 */

const ANSI = /\[[0-9;]*m/gu;

function plain(text: string): string {
  return text.replace(ANSI, '');
}

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [812, '812'],
    [999, '999'],
    [1000, '1.0k'],
    [4243, '4.2k'],
    [9999, '10.0k'],
    [10_000, '10k'],
    [186_400, '186k'],
    [999_999, '1000k'],
    [1_000_000, '1.0M'],
    [1_340_000, '1.3M'],
  ])('renders %i as %s', (value, expected) => {
    expect(formatTokens(value)).toBe(expected);
  });
});

describe('fitLine', () => {
  it('leaves text that already fits untouched', () => {
    expect(fitLine('abc', 10)).toBe('abc');
  });

  it('truncates to the width and treats a negative width as zero', () => {
    expect(plain(fitLine('abcdef', 3))).toBe('abc');
    expect(plain(fitLine('abcdef', 0))).toBe('');
    expect(plain(fitLine('abcdef', -4))).toBe('');
  });
});

describe('padLine', () => {
  it('pads short text out to the full width', () => {
    expect(padLine('ab', 5)).toBe('ab   ');
  });

  it('never pads past the width, and never returns anything for no width', () => {
    expect(plain(padLine('abcdef', 4))).toBe('abcd');
    expect(plain(padLine('abcdef', 0))).toBe('');
    expect(plain(padLine('abcdef', -2))).toBe('');
  });
});

describe('alignLine', () => {
  it('pushes the right side to the far edge', () => {
    expect(plain(alignLine('name', '3.4s', 12))).toBe('name    3.4s');
  });

  it('keeps at least one space between the two sides', () => {
    expect(plain(alignLine('a-very-long-left-side', 'right', 12))).toBe('a-very right');
  });

  it('falls back to the left side when there is no right side', () => {
    expect(plain(alignLine('left-only', '', 6))).toBe('left-o');
  });

  it('drops the left side entirely when the right side fills the width', () => {
    expect(plain(alignLine('left', 'righteous', 6))).toBe('righte');
    expect(plain(alignLine('left', 'right', 5))).toBe('right');
  });
});

describe('frameLine', () => {
  it('wraps padded content in the frame characters', () => {
    expect(plain(frameLine('hi', 8))).toBe('│hi    │');
  });

  it('collapses to the frame alone when the width leaves no room', () => {
    expect(plain(frameLine('hi', 2))).toBe('││');
    expect(plain(frameLine('hi', 1))).toBe('│');
    expect(plain(frameLine('hi', 0))).toBe('');
  });

  it('accepts custom frame characters', () => {
    expect(plain(frameLine('hi', 6, '<', '>'))).toBe('<hi  >');
  });
});

describe('packSegments', () => {
  it('packs as many segments per line as fit', () => {
    expect(packSegments(['aa', 'bb', 'cc'], 10).map(plain)).toEqual(['aa  bb  cc']);
  });

  it('wraps onto a new line when the next segment would overflow', () => {
    expect(packSegments(['aaaa', 'bbbb'], 8).map(plain)).toEqual(['aaaa', 'bbbb']);
  });

  it('truncates a single segment that cannot fit on a line of its own', () => {
    expect(packSegments(['aaaaaaaaaa'], 4).map(plain)).toEqual(['aaaa']);
    expect(packSegments(['ab', 'cccccccc'], 4).map(plain)).toEqual(['ab', 'cccc']);
  });

  it('draws nothing at all when there is no width', () => {
    expect(packSegments(['aa', 'bb'], 0)).toEqual([]);
    expect(packSegments(['aa'], -3)).toEqual([]);
  });

  it('accepts a custom separator', () => {
    expect(packSegments(['aa', 'bb'], 10, ' | ').map(plain)).toEqual(['aa | bb']);
  });

  it('returns nothing for no segments', () => {
    expect(packSegments([], 10)).toEqual([]);
  });
});
