import type { EditorEdit, EditorTextRange } from '../types/editor.ts';

/** Validate and order offset ranges before they reach CodeMirror. */
export function boundedEditorRanges<T extends EditorTextRange>(
  documentLength: number,
  ranges: readonly T[],
): readonly T[] {
  const ordered = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
  let previousEnd = 0;

  for (const [index, range] of ordered.entries()) {
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) {
      throw new RangeError('Editor ranges must use integer offsets');
    }
    if (range.from < 0 || range.to < range.from || range.to > documentLength) {
      throw new RangeError(`Editor range ${index} is outside the document`);
    }
    if (index > 0 && range.from < previousEnd) {
      throw new RangeError('Editor ranges must not overlap');
    }
    previousEnd = Math.max(previousEnd, range.to);
  }

  return ordered;
}

/** Convert caller edits to the bounded, ordered shape accepted by one transaction. */
export function boundedEditorEdits(documentLength: number, edits: readonly EditorEdit[]): readonly EditorEdit[] {
  return boundedEditorRanges(documentLength, edits);
}
