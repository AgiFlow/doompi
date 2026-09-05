import { afterEach, describe, expect, it } from 'vitest';
import {
  addAuthorAnnotation,
  addAuthorRegion,
  authorDocument,
  authorSessionWorkspace,
  authorWorkspace,
  completeAuthorSave,
  dropAuthorSession,
  focusAuthorDocument,
  normalizeAuthorPath,
  putAuthorDocument,
  putAuthorRequest,
  removeAuthorRegion,
  requestAuthorSave,
  reviseAuthorDocument,
  reviseAuthorFragment,
  setAuthorCrop,
} from '../../src/web/authorWorkspaceStore.ts';

afterEach(() => authorWorkspace.reset());

describe('Author workspace store', () => {
  it('keys ephemeral drafts by session and normalized path', () => {
    expect(normalizeAuthorPath(' ./docs/../README.md ')).toBe('README.md');
    putAuthorDocument('s1', { path: './docs/../README.md', kind: 'markdown', content: 'one' });
    putAuthorDocument('s2', { path: 'README.md', kind: 'markdown', content: 'other' });
    reviseAuthorDocument('s1', 'README.md', 'two');
    requestAuthorSave('s1', 'README.md');
    addAuthorAnnotation('s1', 'README.md', { id: 'a1', kind: 'comment', body: 'check this' });

    expect(authorDocument('s1', 'README.md')).toMatchObject({ content: 'two', saveRequest: 1 });
    expect(authorDocument('s1', 'README.md')?.revisions).toEqual([{ revision: 1, content: 'two' }]);
    expect(authorDocument('s2', 'README.md')?.content).toBe('other');
    dropAuthorSession('s1');
    expect(authorDocument('s1', 'README.md')).toBeUndefined();
    expect(authorDocument('s2', 'README.md')).toBeDefined();
  });

  it('keeps edits made during an in-flight save dirty while advancing the saved source', async () => {
    putAuthorDocument('s1', {
      path: 'report.csv',
      kind: 'csv',
      sourceSha256: 'a'.repeat(64),
      fragments: [{ id: 'cell:1:1', kind: 'cell', location: 'A1', text: 'zero' }],
      originalFragments: [{ id: 'cell:1:1', kind: 'cell', location: 'A1', text: 'zero' }],
    });
    reviseAuthorFragment('s1', 'report.csv', 'cell:1:1', 'one');
    const saved = authorDocument('s1', 'report.csv')!;
    let resolveSave!: (sha256: string) => void;
    const pendingSave = new Promise<string>((resolve) => {
      resolveSave = resolve;
    });
    const completion = pendingSave.then((sha256) =>
      completeAuthorSave('s1', 'report.csv', sha256, saved.version, saved.fragments),
    );

    reviseAuthorFragment('s1', 'report.csv', 'cell:1:1', 'two');
    resolveSave('b'.repeat(64));
    await completion;

    expect(authorDocument('s1', 'report.csv')).toMatchObject({
      sourceSha256: 'b'.repeat(64),
      savedVersion: saved.version,
      revisions: [{ revision: 2, content: 'two' }],
      fragments: [{ id: 'cell:1:1', kind: 'cell', location: 'A1', text: 'two' }],
    });
    expect(authorDocument('s1', 'report.csv')?.originalFragments).toEqual(saved.fragments);
  });

  it('versions an image crop and clears the applied crop after its version saves', () => {
    putAuthorDocument('s1', { path: 'photo.png', kind: 'image', mediaUrl: '/photo.png', sourceSha256: 'a' });
    setAuthorCrop('s1', 'photo.png', { x: 0.1, y: 0.2, width: 0.5, height: 0.4 });
    expect(authorDocument('s1', 'photo.png')).toMatchObject({
      version: 1,
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    });

    requestAuthorSave('s1', 'photo.png');
    expect(authorDocument('s1', 'photo.png')?.savingVersion).toBe(1);
    completeAuthorSave('s1', 'photo.png', 'b', 1, undefined);
    expect(authorDocument('s1', 'photo.png')).toMatchObject({ savedVersion: 1, sourceSha256: 'b' });
    expect(authorDocument('s1', 'photo.png')?.crop).toBeUndefined();
  });
  it('keeps ordered native-anchor regions isolated by session and derives order after removal', () => {
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'hello', sourceSha256: 'a' });
    focusAuthorDocument('s1', 'notes.md', 0, 'a');
    const region = (id: string, comment: string) => ({
      id,
      documentPath: 'notes.md',
      revision: 0,
      sourceSha256: 'a',
      comment,
      anchor: { kind: 'text-range' as const, startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    });
    addAuthorRegion('s1', region('r1', 'first'));
    addAuthorRegion('s1', region('r2', 'second'));

    expect(authorSessionWorkspace('s1').regions.map(({ id }) => id)).toEqual(['r1', 'r2']);
    expect(authorSessionWorkspace('s2').regions).toEqual([]);
    removeAuthorRegion('s1', 'r1');
    expect(authorSessionWorkspace('s1').regions.map(({ id }) => id)).toEqual(['r2']);
  });

  it('invalidates unsent anchors after a local document revision', () => {
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'hello', sourceSha256: 'a' });
    focusAuthorDocument('s1', 'notes.md', 0, 'a');
    addAuthorRegion('s1', {
      id: 'r1',
      documentPath: 'notes.md',
      revision: 0,
      sourceSha256: 'a',
      comment: 'rewrite',
      anchor: { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 1, endLine: 1 },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    });

    reviseAuthorDocument('s1', 'notes.md', 'goodbye');

    expect(authorSessionWorkspace('s1')).toMatchObject({
      candidate: undefined,
      regions: [],
      focusedDocument: { revision: 1 },
    });
  });
  it('invalidates drafts and active work on an external source change without rewriting completed history', () => {
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'before', sourceSha256: 'a' });
    focusAuthorDocument('s1', 'notes.md', 0, 'a');
    const region = {
      id: 'r1',
      documentPath: 'notes.md',
      revision: 0,
      sourceSha256: 'a',
      comment: 'change this',
      anchor: { kind: 'text-range' as const, startOffset: 0, endOffset: 6, startLine: 1, endLine: 1 },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    };
    addAuthorRegion('s1', region);
    putAuthorRequest('s1', {
      id: 'active',
      documentPath: 'notes.md',
      requestText: 'rewrite this',
      regions: [region],
      status: 'CHANGING',
      currentOperation: 'replace text',
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      sourceSha256: 'a',
    });
    putAuthorRequest('s1', {
      id: 'done',
      documentPath: 'notes.md',
      requestText: 'earlier change',
      regions: [region],
      status: 'COMPLETE',
      createdAt: 1,
      updatedAt: 2,
      revision: 0,
      sourceSha256: 'a',
    });

    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'external', sourceSha256: 'b' });

    expect(authorSessionWorkspace('s1').regions).toEqual([]);
    expect(authorSessionWorkspace('s1').requests.map(({ id, status }) => [id, status])).toEqual([
      ['active', 'FAILED'],
      ['done', 'COMPLETE'],
    ]);
    expect(authorSessionWorkspace('s1').focusedDocument).toMatchObject({ sourceSha256: 'b', revision: 1 });
  });
});
