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
});
