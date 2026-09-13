import { describe, expect, it } from 'vitest';
import { qrMatrix } from '../../src/web/lib/qrMatrix.ts';

describe('qrMatrix', () => {
  it('returns a square grid of modules', () => {
    const matrix = qrMatrix('https://example.trycloudflare.com/pair#c=abc');
    expect(matrix.length).toBeGreaterThan(20);
    for (const row of matrix) expect(row).toHaveLength(matrix.length);
  });

  it('marks the three finder patterns, which is what a scanner locates first', () => {
    const matrix = qrMatrix('hello');
    const size = matrix.length;
    for (const [row, column] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ]) {
      expect(matrix[row]?.[column]).toBe(true);
    }
  });

  it('grows to fit a longer payload rather than truncating it', () => {
    const short = qrMatrix('a');
    const long = qrMatrix('x'.repeat(400));
    expect(long.length).toBeGreaterThan(short.length);
  });

  it('encodes the same text the same way every time', () => {
    expect(qrMatrix('stable')).toEqual(qrMatrix('stable'));
  });
});
