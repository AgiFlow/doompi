import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendComposerDraft,
  appendComposerQuote,
  attachComposerContext,
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

  it('attaches structured context without changing the visible draft', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'keep this', caret: 9 }));

    attachComposerContext('s1', {
      kind: 'work-item',
      source: 'agiflow',
      id: 'task-1',
      label: 'AGI-1: Fix auth',
      content: 'Status: Todo\n\nFix repository authentication.',
    });

    expect(composerStore.state.s1).toMatchObject({
      draft: 'keep this',
      caret: 9,
      attachmentError: '',
      nextAttachmentId: 1,
    });
    expect(composerStore.state.s1?.attachments).toEqual([
      {
        id: 'context-0',
        kind: 'context',
        name: 'AGI-1: Fix auth',
        size: 44,
        content: 'Status: Todo\n\nFix repository authentication.',
        source: 'agiflow',
        contextId: 'task-1',
      },
    ]);
  });

  it('rejects malformed or oversized plugin context without adding a chip', () => {
    attachComposerContext('s1', { kind: 'work-item', source: '', id: 'task-1', label: 'AGI-1', content: 'work' });
    expect(composerStore.state.s1?.attachmentError).toContain('source');

    attachComposerContext('s1', {
      kind: 'work-item',
      source: 'agiflow',
      id: 'task-1',
      label: 'AGI-1',
      content: 'x'.repeat(100 * 1024 + 1),
    });
    expect(composerStore.state.s1?.attachmentError).toContain('100 KB');
    expect(composerStore.state.s1?.attachments).toEqual([]);
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

  it('formats quoted messages and separates them from an existing instruction', () => {
    expect(appendComposerQuote('s1', 'first line\n\nsecond line')).toBe(30);
    expect(composerStore.state.s1?.draft).toBe('> first line\n>\n> second line\n\n');

    updateComposerState('s1', (state) => ({ ...state, draft: `${state.draft}Focus here.` }));
    expect(appendComposerQuote('s1', '  another message  ')).toBe(62);
    expect(composerStore.state.s1?.draft).toBe(
      '> first line\n>\n> second line\n\nFocus here.\n\n> another message\n\n',
    );
    expect(appendComposerQuote('s1', '   ')).toBeNull();
    expect(appendComposerQuote(null, 'detached')).toBeNull();
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
