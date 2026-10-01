import { afterEach, describe, expect, it } from 'vitest';

import {
  addAuthorAnnotation,
  addAuthorRegion,
  authorDocument,
  authorDocumentAnnotations,
  authorSessionWorkspace,
  authorWorkspace,
  completeAuthorSave,
  dropAuthorSession,
  focusAuthorDocument,
  normalizeAuthorPath,
  putAuthorDocument,
  putAuthorRequest,
  releaseAuthorDocumentFocus,
  removeAuthorRegion,
  requestAuthorSave,
  reviseAuthorDocument,
  reviseAuthorFragment,
  setAuthorCrop,
  setAuthorToolMode,
  authorToolMode,
  updateAuthorRegionComment,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorWorkspaceStore';

afterEach(() => authorWorkspace.reset());

describe('Author workspace store', () => {
  it('keys ephemeral drafts by session and normalized path', () => {
    expect(normalizeAuthorPath(' ./docs/../README.md ')).toBe('README.md');
    putAuthorDocument('s1', { path: './README.md', kind: 'markdown', content: 'one' });
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
    focusAuthorDocument('s1', 'notes.md');
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

    expect(authorDocumentAnnotations('s1', 'notes.md').annotations.map(({ id }) => id)).toEqual(['r1', 'r2']);
    expect(authorDocumentAnnotations('s2', 'notes.md').annotations).toEqual([]);
    removeAuthorRegion('s1', 'notes.md', 'r1');
    expect(authorDocumentAnnotations('s1', 'notes.md').annotations.map(({ id }) => id)).toEqual(['r2']);
  });

  it('keeps versioned mixed annotations per document across focus release and tab switches', () => {
    putAuthorDocument('s1', { path: 'one.png', kind: 'image', sourceSha256: 'one' });
    putAuthorDocument('s1', { path: 'two.png', kind: 'image', sourceSha256: 'two' });
    const firstGeneration = focusAuthorDocument('s1', 'one.png');
    addAuthorRegion('s1', {
      id: 'point',
      documentPath: 'one.png',
      revision: 0,
      sourceSha256: 'one',
      mode: 'point',
      comment: 'Move this',
      anchor: { kind: 'image-point', point: { x: 0.5, y: 0.25 }, naturalWidth: 100, naturalHeight: 100 },
      viewport: { width: 100, height: 100 },
      createdAt: 1,
    });
    updateAuthorRegionComment('s1', 'one.png', 'point', 'Move this lower');
    expect(authorDocumentAnnotations('s1', 'one.png').annotations[0]).toMatchObject({
      id: 'point',
      version: 2,
      mode: 'point',
    });

    focusAuthorDocument('s1', 'two.png');
    expect(authorDocumentAnnotations('s1', 'two.png').annotations).toEqual([]);
    expect(authorDocumentAnnotations('s1', 'one.png')?.annotations).toHaveLength(1);
    focusAuthorDocument('s1', 'one.png');
    expect(authorDocumentAnnotations('s1', 'one.png').annotations[0]).toMatchObject({ id: 'point', version: 2 });

    releaseAuthorDocumentFocus('s1', firstGeneration);
    expect(authorDocumentAnnotations('s1', 'one.png')?.annotations).toHaveLength(1);
  });

  it('routes hidden-document mutations and tools by path without reviving stale anchors', () => {
    putAuthorDocument('s1', { path: 'a.png', kind: 'image', sourceSha256: 'a' });
    putAuthorDocument('s1', { path: 'b.png', kind: 'image', sourceSha256: 'b' });
    focusAuthorDocument('s1', 'b.png');
    setAuthorToolMode('s1', './a.png', 'draw');
    addAuthorRegion('s1', {
      id: 'a',
      documentPath: 'a.png',
      revision: 0,
      sourceSha256: 'a',
      comment: 'Fix A',
      anchor: { kind: 'image-point', point: { x: 0.1, y: 0.2 }, naturalWidth: 100, naturalHeight: 100 },
      viewport: { width: 100, height: 100 },
      createdAt: 1,
    });
    expect(authorDocumentAnnotations('s1', 'a.png').annotations).toHaveLength(1);
    expect(authorDocumentAnnotations('s1', 'b.png').annotations).toEqual([]);
    expect(authorToolMode('s1', 'a.png')).toBe('draw');
    expect(authorToolMode('s1', 'b.png')).toBe('select');
    putAuthorRequest('s1', {
      id: 'hidden',
      documentPath: 'a.png',
      requestText: 'Fix A',
      regions: authorDocumentAnnotations('s1', 'a.png').annotations,
      status: 'CHANGING',
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      sourceSha256: 'a',
    });
    putAuthorDocument('s1', { path: 'a.png', kind: 'image', sourceSha256: 'new' });
    expect(authorSessionWorkspace('s1').requests[0]?.status).toBe('FAILED');
    updateAuthorRegionComment('s1', 'a.png', 'a', 'Do not restore');
    expect(authorDocumentAnnotations('s1', 'a.png').annotations).toEqual([]);
    expect(authorDocumentAnnotations('s1', 'a.png').revision).toBe(1);
  });

  it('invalidates unsent anchors after a local document revision', () => {
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'hello', sourceSha256: 'a' });
    focusAuthorDocument('s1', 'notes.md');
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

    expect(authorDocumentAnnotations('s1', 'notes.md')).toMatchObject({ candidate: undefined, annotations: [] });
    expect(authorDocument('s1', 'notes.md')?.version).toBe(1);
  });
  it('keeps submitted preview requests immutable while invalidating stale draft regions after a rebuild', () => {
    const preview = {
      version: 1 as const,
      provider: 'style-system',
      projectPath: 'apps/site',
      storyPath: 'src/Button.stories.tsx',
      storyExport: 'Primary',
      buildRevision: 'build-1',
      viewport: { width: 800, height: 600 },
      sources: [{ path: 'apps/site/src/Button.tsx', sha256: 'a' }],
    };
    const path = 'author-preview/style-system/button-primary';
    putAuthorDocument('s1', { path, kind: 'story-preview', sourceSha256: 'a', storyPreview: preview });
    focusAuthorDocument('s1', path);
    const region = {
      id: 'r1',
      documentPath: path,
      revision: 0,
      sourceSha256: 'a',
      comment: 'increase contrast',
      anchor: {
        kind: 'story-preview-rect' as const,
        rect: { x: 0, y: 0, width: 0.5, height: 0.5 },
        preview,
      },
      viewport: { width: 800, height: 600 },
      createdAt: 1,
    };
    addAuthorRegion('s1', region);
    putAuthorRequest('s1', {
      id: 'active-preview',
      documentPath: path,
      requestText: 'increase contrast',
      regions: [region],
      status: 'CHANGING',
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      sourceSha256: 'a',
    });

    putAuthorDocument('s1', {
      path,
      kind: 'story-preview',
      sourceSha256: 'b',
      storyPreview: { ...preview, buildRevision: 'build-2' },
    });

    expect(authorDocumentAnnotations('s1', path).annotations).toEqual([]);
    expect(authorSessionWorkspace('s1').requests[0]).toMatchObject({ id: 'active-preview', status: 'CHANGING' });
    expect(authorSessionWorkspace('s1').requests[0]!.regions).toEqual([region]);
  });

  it('invalidates drafts and active work on an external source change without rewriting completed history', () => {
    putAuthorDocument('s1', { path: 'notes.md', kind: 'markdown', content: 'before', sourceSha256: 'a' });
    focusAuthorDocument('s1', 'notes.md');
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

    expect(authorDocumentAnnotations('s1', 'notes.md').annotations).toEqual([]);
    expect(authorSessionWorkspace('s1').requests.map(({ id, status }) => [id, status])).toEqual([
      ['active', 'FAILED'],
      ['done', 'COMPLETE'],
    ]);
    expect(authorDocument('s1', 'notes.md')).toMatchObject({ sourceSha256: 'b', version: 1 });
  });
});
