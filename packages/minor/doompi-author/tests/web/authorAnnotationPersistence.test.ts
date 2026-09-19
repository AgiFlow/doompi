import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHOR_ANNOTATION_EVIDENCE_BYTE_LIMIT,
  IndexedDbAuthorAnnotationRepository,
  startAuthorAnnotationPersistence,
  validateAuthorAnnotationRecord,
  type AuthorAnnotationPersistenceRecord,
  type AuthorAnnotationRepository,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorAnnotationPersistence';
import {
  addAuthorRegion,
  authorDocumentAnnotations,
  authorWorkspace,
  focusAuthorDocument,
  putAuthorDocument,
} from '../../src/extensions/workspaces/sessions/(frontend)/_lib/authorWorkspaceStore';

const annotation = {
  id: 'a1',
  documentPath: 'notes.md',
  revision: 0,
  sourceSha256: 'sha',
  comment: 'Clarify this',
  version: 1,
  anchor: { kind: 'image-point' as const, point: { x: 0.25, y: 0.75 }, naturalWidth: 100, naturalHeight: 50 },
  viewport: { width: 100, height: 50 },
  evidence: new Blob(['evidence'], { type: 'image/png' }),
  createdAt: 1,
};

function record(overrides: Partial<AuthorAnnotationPersistenceRecord> = {}): AuthorAnnotationPersistenceRecord {
  return {
    key: 's\nnotes.md',
    version: 1,
    sessionId: 's',
    documentPath: 'notes.md',
    collection: {
      revision: 0,
      sourceSha256: 'sha',
      stale: false,
      candidateText: 'draft words',
      annotations: [annotation],
      updatedAt: 1,
    },
    ...overrides,
  };
}

const tick = async () => await new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  authorWorkspace.reset();
  vi.restoreAllMocks();
});

describe('Author annotation persistence', () => {
  it('validates structure, point anchors, bounds, identity keys, and Blob evidence', () => {
    expect(validateAuthorAnnotationRecord(record())).toBeDefined();
    const anchors = [
      { kind: 'text-range', startOffset: 0, endOffset: 1, startLine: 1, endLine: 1 },
      { kind: 'cell', fragmentId: 'cell', location: 'A1' },
      { kind: 'slide-element', fragmentId: 'shape', slide: 1, location: 'Slide 1' },
      { kind: 'image-rect', rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, naturalWidth: 100, naturalHeight: 50 },
      { kind: 'pdf-page-rect', page: 1, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { kind: 'video-time-rect', timeSeconds: 1, rect: { x: 0, y: 0, width: 0.5, height: 0.5 } },
      { kind: 'story-preview-rect', rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, preview: {} },
      { kind: 'pdf-page-point', page: 1, point: { x: 0.5, y: 0.5 } },
      { kind: 'video-time-point', timeSeconds: 1, point: { x: 0.5, y: 0.5 } },
      { kind: 'story-preview-point', point: { x: 0.5, y: 0.5 }, preview: {} },
    ];
    for (const anchor of anchors) {
      expect(
        validateAuthorAnnotationRecord({
          ...record(),
          collection: { ...record().collection, annotations: [{ ...annotation, anchor }] },
        }),
      ).toBeDefined();
    }
    expect(
      validateAuthorAnnotationRecord({
        ...record(),
        collection: { ...record().collection, annotations: [{ ...annotation, anchor: { kind: 'unknown' } }] },
      }),
    ).toBeUndefined();
    expect(validateAuthorAnnotationRecord({ ...record(), key: 'other' })).toBeUndefined();
    expect(
      validateAuthorAnnotationRecord({
        ...record(),
        collection: { ...record().collection, candidateText: 'x'.repeat(2 * 1024 + 1) },
      }),
    ).toBeUndefined();
    expect(
      validateAuthorAnnotationRecord({
        ...record(),
        collection: {
          ...record().collection,
          annotations: [{ ...annotation, anchor: { ...annotation.anchor, point: { x: 2, y: 0 } } }],
        },
      }),
    ).toBeUndefined();
    expect(
      validateAuthorAnnotationRecord({
        ...record(),
        collection: {
          ...record().collection,
          annotations: [
            { ...annotation, evidence: new Blob([new Uint8Array(AUTHOR_ANNOTATION_EVIDENCE_BYTE_LIMIT + 1)]) },
          ],
        },
      }),
    ).toBeUndefined();
  });

  it('hydrates before its first write and does not overwrite newer in-memory annotations', async () => {
    let resolveLoad!: (records: readonly unknown[]) => void;
    const load = new Promise<readonly unknown[]>((resolve) => {
      resolveLoad = resolve;
    });
    const writes: readonly AuthorAnnotationPersistenceRecord[][] = [];
    const repository: AuthorAnnotationRepository = {
      load: () => load,
      replace: vi.fn(async (records) => {
        (writes as AuthorAnnotationPersistenceRecord[][]).push([...records]);
      }),
      close: vi.fn(async () => undefined),
    };
    const stop = startAuthorAnnotationPersistence(repository);

    putAuthorDocument('s', { path: 'notes.md', kind: 'markdown', content: 'text', sourceSha256: 'sha' });
    focusAuthorDocument('s', 'notes.md', 0, 'sha');
    addAuthorRegion('s', { ...annotation, id: 'newer', createdAt: 2 });
    expect(repository.replace).not.toHaveBeenCalled();

    resolveLoad([record()]);
    await tick();
    await tick();

    expect(authorDocumentAnnotations('s', 'notes.md')?.annotations.map(({ id }) => id)).toEqual(['newer']);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]?.collection.annotations[0]?.id).toBe('newer');
    await stop();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('marks hydrated annotations stale when their document identity has changed', async () => {
    putAuthorDocument('s', { path: 'notes.md', kind: 'markdown', content: 'changed', sourceSha256: 'new' });
    const repository: AuthorAnnotationRepository = {
      load: async () => [record()],
      replace: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const stop = startAuthorAnnotationPersistence(repository);
    await tick();

    expect(authorDocumentAnnotations('s', 'notes.md')).toMatchObject({ stale: true, sourceSha256: 'sha' });
    await stop();
  });

  it('drains queued IndexedDB writes before closing the database', async () => {
    let completeWrite!: () => void;
    const close = vi.fn();
    const transaction = {
      objectStore: () => ({ clear: vi.fn(), put: vi.fn() }),
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      error: null,
    };
    completeWrite = () => transaction.oncomplete?.();
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: () => transaction,
      close,
    };
    const request = {
      result: database,
      error: null,
      onupgradeneeded: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    const repository = new IndexedDbAuthorAnnotationRepository({
      open: () => {
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } as unknown as IDBFactory);

    const write = repository.replace([record()]);
    await tick();
    const closing = repository.close();
    await tick();
    expect(close).not.toHaveBeenCalled();
    completeWrite();
    await Promise.all([write, closing]);
    expect(close).toHaveBeenCalledOnce();
  });
});
