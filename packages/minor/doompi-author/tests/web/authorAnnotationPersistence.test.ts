import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHOR_ANNOTATION_EVIDENCE_BYTE_LIMIT,
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
      close: vi.fn(),
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
    stop();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('marks hydrated annotations stale when their document identity has changed', async () => {
    putAuthorDocument('s', { path: 'notes.md', kind: 'markdown', content: 'changed', sourceSha256: 'new' });
    const repository: AuthorAnnotationRepository = {
      load: async () => [record()],
      replace: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const stop = startAuthorAnnotationPersistence(repository);
    await tick();

    expect(authorDocumentAnnotations('s', 'notes.md')).toMatchObject({ stale: true, sourceSha256: 'sha' });
    stop();
  });
});
