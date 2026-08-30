import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendComposerDraft,
  clearComposerState,
  composerStore,
  dropComposerState,
  resetComposerStore,
  updateComposerState,
} from '../../src/web/stores/composerStore.ts';

beforeEach(() => resetComposerStore());

describe('composer state', () => {
  it('retains unfinished input independently for each session', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'first draft', caret: 11 }));
    updateComposerState('s2', (state) => ({ ...state, draft: 'second draft', caret: 12 }));

    expect(composerStore.state.s1).toMatchObject({ draft: 'first draft', caret: 11 });
    expect(composerStore.state.s2).toMatchObject({ draft: 'second draft', caret: 12 });

    clearComposerState('s1');
    expect(composerStore.state.s1).toMatchObject({ draft: '', caret: 0, attachments: [] });
    expect(composerStore.state.s2).toMatchObject({ draft: 'second draft', caret: 12 });
  });

  it('appends trimmed text to the latest session draft without disturbing its attachments or errors', () => {
    updateComposerState('s1', (state) => ({
      ...state,
      draft: 'first',
      caret: 2,
      dismissedToken: 0,
      attachments: [{ id: 'a1', kind: 'text', name: 'notes.txt', size: 5, content: 'notes' }],
      attachmentError: 'keep this',
    }));

    appendComposerDraft('s1', '  second  ');
    appendComposerDraft('s1', 'third');

    expect(composerStore.state.s1).toMatchObject({
      draft: 'first second third',
      caret: 18,
      dismissedToken: null,
      attachmentError: 'keep this',
    });
    expect(composerStore.state.s1?.attachments).toHaveLength(1);
  });

  it('uses existing draft whitespace as the separator and ignores empty appends', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'first\n' }));
    appendComposerDraft('s1', ' second ');
    appendComposerDraft('s1', '   ');
    appendComposerDraft(null, 'detached');

    expect(composerStore.state.s1?.draft).toBe('first\nsecond');
    expect(composerStore.state.s1?.caret).toBe(12);
    expect(Object.keys(composerStore.state)).toEqual(['s1']);
  });

  it('ignores detached updates and removes state for sessions that leave', () => {
    updateComposerState(null, () => {
      throw new Error('detached composer update should not run');
    });
    clearComposerState(null);
    expect(composerStore.state).toEqual({});

    updateComposerState('s1', (state) => ({ ...state, draft: 'discard me' }));
    dropComposerState('missing');
    dropComposerState('s1');
    expect(composerStore.state).toEqual({});
  });
});
