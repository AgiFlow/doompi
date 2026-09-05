import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { resolveEditorViewportRegion } from '../../src/components/CodeEditorView.tsx';

describe('CodeEditor viewport geometry', () => {
  it('resolves client geometry to an ordered native text range', () => {
    const state = EditorState.create({ doc: 'alpha\nbeta' });
    const editor = {
      state,
      posAtCoords: ({ x }: { x: number }) => (x < 50 ? 9 : 1),
    };

    expect(resolveEditorViewportRegion(editor, { left: 0, top: 0, right: 100, bottom: 100 })).toEqual({
      text: 'lpha\nbet',
      from: 1,
      to: 9,
      startLine: 1,
      endLine: 2,
    });
  });

  it('returns null when geometry misses the mounted document', () => {
    const state = EditorState.create({ doc: 'alpha' });
    expect(
      resolveEditorViewportRegion({ state, posAtCoords: () => null }, { left: 0, top: 0, right: 100, bottom: 100 }),
    ).toBeNull();
  });
  it('passes viewport coordinates through unchanged and preserves an empty cursor range', () => {
    const coordinates: { x: number; y: number }[] = [];
    const editor = {
      state: EditorState.create({ doc: 'alpha\nbeta' }),
      posAtCoords: (coords: { x: number; y: number }) => {
        coordinates.push(coords);
        return 6;
      },
    };
    expect(resolveEditorViewportRegion(editor, { left: 120, top: 80, right: 160, bottom: 100 })).toEqual({
      text: '',
      from: 6,
      to: 6,
      startLine: 2,
      endLine: 2,
    });
    expect(coordinates).toEqual([
      { x: 120, y: 80 },
      { x: 160, y: 100 },
    ]);
  });

  it('rejects a rectangle when only its ending corner misses the document', () => {
    const state = EditorState.create({ doc: 'alpha' });
    expect(
      resolveEditorViewportRegion(
        { state, posAtCoords: ({ x }) => (x === 0 ? 0 : null) },
        {
          left: 0,
          top: 0,
          right: 100,
          bottom: 100,
        },
      ),
    ).toBeNull();
  });
});
