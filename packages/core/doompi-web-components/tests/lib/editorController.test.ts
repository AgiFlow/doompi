import { describe, expect, it } from 'vitest';
import { boundedEditorEdits, boundedEditorRanges } from '../../src/lib/editorController.ts';

describe('boundedEditorEdits', () => {
  it('orders nonoverlapping edits for a single CodeMirror transaction', () => {
    expect(
      boundedEditorEdits(8, [
        { from: 6, to: 8, insert: '!' },
        { from: 0, to: 2, insert: 'A' },
        { from: 2, to: 2, insert: 'B' },
      ]),
    ).toEqual([
      { from: 0, to: 2, insert: 'A' },
      { from: 2, to: 2, insert: 'B' },
      { from: 6, to: 8, insert: '!' },
    ]);
  });

  it('rejects out-of-bounds and overlapping edits', () => {
    expect(() => boundedEditorEdits(4, [{ from: 0, to: 5, insert: '' }])).toThrow(RangeError);
    expect(() =>
      boundedEditorEdits(8, [
        { from: 1, to: 4, insert: '' },
        { from: 3, to: 5, insert: '' },
      ]),
    ).toThrow('must not overlap');
  });
});

describe('boundedEditorRanges', () => {
  it('accepts bounded empty ranges for closed-line decorations', () => {
    expect(boundedEditorRanges(3, [{ from: 3, to: 3 }])).toEqual([{ from: 3, to: 3 }]);
  });

  it('requires integer offsets', () => {
    expect(() => boundedEditorRanges(3, [{ from: 0.5, to: 2 }])).toThrow('integer offsets');
  });
});
