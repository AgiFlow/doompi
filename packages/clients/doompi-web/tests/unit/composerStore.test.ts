import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendComposerDraft,
  appendComposerQuote,
  attachComposerCapture,
  attachComposerContext,
  clearComposerState,
  composerStore,
  dropComposerState,
  resetComposerStore,
  updateComposerState,
} from '../../src/web/stores/composerStore.ts';

function base64(bytes: readonly number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function png(width: number, height: number): string {
  return base64([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
}

function jpeg(width: number, height: number): string {
  return base64([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
}

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

  it('atomically stages a validated capture and nested context without changing the draft', () => {
    updateComposerState('s1', (state) => ({ ...state, draft: 'keep this', caret: 9 }));
    let updates = 0;
    const unsubscribe = composerStore.subscribe(() => {
      updates += 1;
    });

    attachComposerCapture('s1', {
      data: png(1, 1),
      mimeType: 'image/png',
      context: {
        kind: 'browser-page',
        source: 'author',
        id: 'https://example.com/docs',
        label: 'Example docs',
        content: 'Captured from https://example.com/docs',
        url: 'https://example.com/docs',
      },
    });
    unsubscribe.unsubscribe();

    expect(updates).toBe(1);
    expect(composerStore.state.s1).toMatchObject({ draft: 'keep this', caret: 9, nextAttachmentId: 2 });
    expect(composerStore.state.s1?.attachments).toEqual([
      {
        id: 'capture-0',
        kind: 'image',
        name: 'Example docs.png',
        size: 24,
        dataUrl: `data:image/png;base64,${png(1, 1)}`,
        data: png(1, 1),
        mimeType: 'image/png',
      },
      {
        id: 'context-1',
        kind: 'context',
        name: 'Example docs',
        size: 38,
        content: 'Captured from https://example.com/docs',
        source: 'author',
        contextId: 'https://example.com/docs',
      },
    ]);
  });

  it('rejects invalid capture data as one host update without partially staging context', () => {
    let updates = 0;
    const unsubscribe = composerStore.subscribe(() => {
      updates += 1;
    });
    attachComposerCapture('s1', {
      data: 'not base64',
      mimeType: 'image/png',
      context: { kind: 'browser-page', source: 'author', id: 'page-1', label: 'Page', content: 'valid context' },
    });
    unsubscribe.unsubscribe();

    expect(updates).toBe(1);
    expect(composerStore.state.s1?.attachments).toEqual([]);
    expect(composerStore.state.s1?.attachmentError).toContain('base64 PNG or JPEG');
  });

  it('accepts a bounded JPEG capture using its encoded dimensions', () => {
    attachComposerCapture('s1', {
      data: jpeg(1600, 900),
      mimeType: 'image/jpeg',
      context: { kind: 'browser-page', source: 'author', id: 'page-1', label: 'Page', content: 'valid context' },
    });

    expect(composerStore.state.s1?.attachmentError).toBe('');
    expect(composerStore.state.s1?.attachments[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      size: 21,
    });
  });

  it.each([
    ['corrupt PNG', base64([0x89, 0x50, 0x4e, 0x47]), 'image/png' as const],
    ['PNG labeled as JPEG', png(1, 1), 'image/jpeg' as const],
    ['oversized dimensions', png(1601, 1), 'image/png' as const],
    ['zero dimensions', png(0, 1), 'image/png' as const],
  ])('rejects %s without staging either attachment', (_description, data, mimeType) => {
    attachComposerCapture('s1', {
      data,
      mimeType,
      context: { kind: 'browser-page', source: 'author', id: 'page-1', label: 'Page', content: 'valid context' },
    });

    expect(composerStore.state.s1?.attachments).toEqual([]);
    expect(composerStore.state.s1?.attachmentError).toContain('base64 PNG or JPEG');
  });

  it('rejects decodable but non-canonical base64', () => {
    const canonical = base64([...atob(png(1, 1))].map((byte) => byte.charCodeAt(0)).concat(0));
    const nonCanonical = `${canonical.slice(0, -3)}B==`;

    attachComposerCapture('s1', {
      data: nonCanonical,
      mimeType: 'image/png',
      context: { kind: 'browser-page', source: 'author', id: 'page-1', label: 'Page', content: 'valid context' },
    });

    expect(atob(nonCanonical)).toBe(atob(canonical));
    expect(composerStore.state.s1?.attachments).toEqual([]);
    expect(composerStore.state.s1?.attachmentError).toContain('base64 PNG or JPEG');
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
    updateComposerState('s2', (state) => ({ ...state, draft: 'one newline\n' }));
    updateComposerState('s3', (state) => ({ ...state, draft: 'two newlines\n\n' }));
    expect(appendComposerQuote('s2', 'quote')).toBe(22);
    expect(appendComposerQuote('s3', 'quote')).toBe(23);
    expect(appendComposerQuote('s1', '   ')).toBeNull();
    expect(appendComposerQuote(null, 'detached')).toBeNull();
  });

  it('rejects detached, full, and over-budget plugin context', () => {
    const item = { kind: 'work-item', source: 'agiflow', id: 'task-1', label: 'AGI-1', content: 'work' };
    attachComposerContext(null, item);

    updateComposerState('full', (state) => ({
      ...state,
      attachments: Array.from({ length: 8 }, (_, index) => ({
        id: `image-${String(index)}`,
        kind: 'image' as const,
        name: 'image.png',
        size: 1,
        dataUrl: 'data:image/png;base64,eA==',
        data: 'eA==',
        mimeType: 'image/png',
      })),
    }));
    attachComposerContext('full', item);
    expect(composerStore.state.full?.attachmentError).toContain('8 attachments');

    updateComposerState('budget', (state) => ({
      ...state,
      attachments: [
        {
          id: 'image-1',
          kind: 'image',
          name: 'image.png',
          size: 1,
          dataUrl: 'data:image/png;base64,eA==',
          data: 'eA==',
          mimeType: 'image/png',
        },
        { id: 'text-1', kind: 'text', name: 'notes.txt', size: 200 * 1024, content: 'notes' },
      ],
    }));
    attachComposerContext('budget', item);
    expect(composerStore.state.budget?.attachmentError).toContain('200 KB total');
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
