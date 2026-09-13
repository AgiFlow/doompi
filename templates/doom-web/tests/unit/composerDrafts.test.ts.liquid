import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composerStore,
  resetComposerStore,
  restoreComposerDrafts,
  saveComposerDrafts,
  updateComposerState,
} from '../../src/web/stores/composerStore.ts';

const store = new Map<string, string>();
let throwOnWrite = false;

// The module reads window.sessionStorage, so that is what has to exist.
Object.defineProperty(globalThis, 'window', {
  value: {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (throwOnWrite) throw new Error('quota exceeded');
        store.set(key, value);
      },
      removeItem: (key: string) => store.delete(key),
    },
  },
  configurable: true,
});

beforeEach(() => {
  resetComposerStore();
  store.clear();
  throwOnWrite = false;
});

afterEach(() => {
  resetComposerStore();
  store.clear();
});

describe('composer drafts across an unasked-for reload', () => {
  it('carries unsent text and its caret back per session', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'half a thought', caret: 6 }));
    updateComposerState('s2', (state) => ({ ...state, draft: 'another one', caret: 11 }));

    saveComposerDrafts();
    resetComposerStore();
    restoreComposerDrafts();

    expect(composerStore.state.s1).toMatchObject({ draft: 'half a thought', caret: 6 });
    expect(composerStore.state.s2).toMatchObject({ draft: 'another one', caret: 11 });
  });

  it('leaves attachments behind, because a base64 payload does not fit a quota', () => {
    updateComposerState('s1', (state) => ({
      ...state,
      draft: 'see the picture',
      caret: 3,
      attachments: [{ id: 'a1', kind: 'text', name: 'note.txt', size: 4, content: 'note' }],
    }));

    saveComposerDrafts();
    resetComposerStore();
    restoreComposerDrafts();

    expect(composerStore.state.s1).toMatchObject({ draft: 'see the picture', caret: 3 });
    expect(composerStore.state.s1?.attachments).toEqual([]);
  });

  it('forgets the save once it is restored, so a later reload starts clean', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'once', caret: 4 }));
    saveComposerDrafts();

    resetComposerStore();
    restoreComposerDrafts();
    resetComposerStore();
    restoreComposerDrafts();

    expect(composerStore.state.s1).toBeUndefined();
  });

  it('stores nothing when every composer is empty', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: '', caret: 0 }));

    saveComposerDrafts();

    expect(store.size).toBe(0);
  });

  it('clears a previous save when the drafts are emptied', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'typed', caret: 5 }));
    saveComposerDrafts();
    updateComposerState('s1', (state) => ({ ...state, draft: '', caret: 0 }));

    saveComposerDrafts();

    expect(store.size).toBe(0);
  });

  it('keeps the reload going when storage refuses the write', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'lost but harmless', caret: 4 }));
    throwOnWrite = true;

    expect(() => saveComposerDrafts()).not.toThrow();
  });

  it('ignores a payload that is not the shape it wrote', () => {
    store.set('doompi:composer-drafts', 'not json at all');
    expect(() => restoreComposerDrafts()).not.toThrow();
    expect(composerStore.state.s1).toBeUndefined();

    store.set('doompi:composer-drafts', JSON.stringify(['an', 'array']));
    restoreComposerDrafts();
    expect(composerStore.state.s1).toBeUndefined();

    store.set('doompi:composer-drafts', JSON.stringify({ s1: { draft: '', caret: 0 } }));
    restoreComposerDrafts();
    expect(composerStore.state.s1).toBeUndefined();

    store.set('doompi:composer-drafts', JSON.stringify({ s1: { draft: 'text', caret: 'nope' } }));
    restoreComposerDrafts();
    expect(composerStore.state.s1).toBeUndefined();

    store.set('doompi:composer-drafts', JSON.stringify({ s1: null }));
    restoreComposerDrafts();
    expect(composerStore.state.s1).toBeUndefined();
  });

  it('clamps a caret that no longer fits the text it was saved with', () => {
    store.set('doompi:composer-drafts', JSON.stringify({ s1: { draft: 'short', caret: 900 } }));

    restoreComposerDrafts();

    expect(composerStore.state.s1).toMatchObject({ draft: 'short', caret: 5 });
  });

  it('restores nothing when there was no save', () => {
    restoreComposerDrafts();

    expect(composerStore.state).toEqual({});
  });
});
