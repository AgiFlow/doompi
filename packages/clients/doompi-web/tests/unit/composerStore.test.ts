import { beforeEach, describe, expect, it } from 'vitest';
import {
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
