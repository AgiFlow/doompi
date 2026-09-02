import { describe, expect, it } from 'vitest';
import { barFraction, evenPositions, formatTokens, seriesMax } from '../src/web/charts/chartScale.ts';

/**
 * The chart arithmetic, tested as functions. The failure that matters here is
 * a bar drawn off its track or a divide by zero on an empty series, both of
 * which are arithmetic, not rendering.
 */

describe('barFraction', () => {
  it('scales a value against the series peak', () => {
    expect(barFraction(50, 200)).toBe(0.25);
    expect(barFraction(200, 200)).toBe(1);
  });

  it('never exceeds the track', () => {
    expect(barFraction(500, 200)).toBe(1);
  });

  it('collapses rather than dividing by zero on an all-zero series', () => {
    // A period the sink answered with zero tokens is a real state, not a bug,
    // so it draws no bar instead of NaN.
    expect(barFraction(0, 0)).toBe(0);
    expect(barFraction(10, 0)).toBe(0);
  });

  it('treats a negative or non-finite value as no bar', () => {
    expect(barFraction(-5, 100)).toBe(0);
    expect(barFraction(Number.NaN, 100)).toBe(0);
  });
});

describe('seriesMax', () => {
  it('is zero for an empty series', () => {
    expect(seriesMax([])).toBe(0);
  });

  it('finds the peak', () => {
    expect(seriesMax([3, 91, 7])).toBe(91);
  });
});

describe('formatTokens', () => {
  it('compacts thousands and millions', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_500)).toBe('1.5k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });
});

describe('evenPositions', () => {
  it('puts a lone point at the left edge instead of dividing by zero', () => {
    expect(evenPositions(1)).toEqual([0]);
  });

  it('spans the full width for a longer series', () => {
    expect(evenPositions(3)).toEqual([0, 0.5, 1]);
  });

  it('is empty for no points', () => {
    expect(evenPositions(0)).toEqual([]);
  });
});
