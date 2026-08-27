import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../../src/services/lineDiff.ts';

/** Every row of every hunk, flattened, for assertions that do not care where the gaps fell. */
function rows(result: ReturnType<typeof lineDiff>) {
  return result.hunks.flatMap((hunk) => hunk.rows).map((row) => `${row.marker}${row.line} ${row.content}`);
}

describe('lineDiff', () => {
  it('reports an addition against the new file’s line numbers', () => {
    const result = lineDiff('one\ntwo\n', 'one\ntwo\nthree\n');
    expect(result.additions).toBe(1);
    expect(result.removals).toBe(0);
    expect(rows(result)).toContain('+3 three');
  });

  it('reports a removal against the old file’s line numbers', () => {
    const result = lineDiff('one\ntwo\nthree\n', 'one\nthree\n');
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(1);
    expect(rows(result)).toContain('-2 two');
  });

  it('pairs a replacement as one removal and one addition', () => {
    const result = lineDiff('alpha\nbeta\n', 'alpha\ngamma\n');
    expect([result.additions, result.removals]).toEqual([1, 1]);
    expect(rows(result)).toEqual(expect.arrayContaining(['-2 beta', '+2 gamma']));
  });

  it('answers nothing changed when the two sides match', () => {
    const result = lineDiff('same\ntext\n', 'same\ntext\n');
    expect(result.hunks).toEqual([]);
    expect([result.additions, result.removals]).toEqual([0, 0]);
  });

  it('splits distant changes into separate hunks and keeps context around each', () => {
    const before = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');
    const after = before.replace('line 5', 'line five').replace('line 50', 'line fifty');
    const result = lineDiff(before, after);
    expect(result.hunks).toHaveLength(2);
    // Three lines of context either side of a single changed line.
    expect(result.hunks[0]?.rows).toHaveLength(8);
    expect(result.hunks[0]?.start).toBe(2);
    expect(result.hunks[1]?.start).toBe(47);
  });

  it('normalises CRLF so a line-ending change alone is not a diff', () => {
    const result = lineDiff('one\r\ntwo\r\n', 'one\ntwo\n');
    expect(result.hunks).toEqual([]);
  });

  it('handles a file that did not exist before', () => {
    const result = lineDiff('', 'fresh\ncontent\n');
    expect(result.removals).toBe(0);
    expect(result.additions).toBe(3);
  });

  it('falls back to a wholesale replacement when the changed region is too large to match', () => {
    // The cap is on the product of the two changed regions, so two large and
    // entirely different bodies are what trips it.
    const before = Array.from({ length: 1200 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 1200 }, (_, index) => `new ${index}`).join('\n');
    const result = lineDiff(before, after);
    expect(result.approximate).toBe(true);
    expect(result.removals).toBe(1200);
    expect(result.additions).toBe(1200);
  });

  it('reports a file emptied to nothing as all removals', () => {
    const result = lineDiff('one\ntwo\n', '');
    expect(result.additions).toBe(0);
    expect(result.removals).toBe(3);
  });

  it('reads two empty files as no change at all', () => {
    expect(lineDiff('', '')).toMatchObject({ hunks: [], additions: 0, removals: 0, approximate: false });
  });

  it('handles a change at the very first line, where there is no leading context', () => {
    const result = lineDiff('first\nsecond\nthird\n', 'FIRST\nsecond\nthird\n');
    expect(rows(result)).toEqual(expect.arrayContaining(['-1 first', '+1 FIRST']));
    expect(result.hunks[0]?.start).toBe(1);
  });

  it('keeps a shared prefix and suffix out of the matched region', () => {
    // The trimming is what makes a one-line change in a large file cheap, so a
    // change surrounded by thousands of identical lines must stay exact.
    const head = Array.from({ length: 2000 }, (_, index) => `head ${index}`).join('\n');
    const tail = Array.from({ length: 2000 }, (_, index) => `tail ${index}`).join('\n');
    const result = lineDiff(`${head}\nmiddle\n${tail}`, `${head}\nchanged\n${tail}`);
    expect(result.approximate).toBe(false);
    expect([result.additions, result.removals]).toEqual([1, 1]);
    expect(result.hunks).toHaveLength(1);
  });
});
