import type { AuthorAnnotationCandidate, AuthorAnnotationDraft, AuthorNativeAnchor } from './authorViewportTypes';
import {
  AUTHOR_REGION_LIMIT,
  authorWorkspace,
  hydrateAuthorAnnotationCollections,
  normalizeAuthorPath,
  type AuthorAnnotationHydrationRecord,
} from './authorWorkspaceStore';

export const AUTHOR_ANNOTATION_DATABASE = 'doompi-author-annotations';
export const AUTHOR_ANNOTATION_RECORD_LIMIT = 100;
export const AUTHOR_ANNOTATION_EVIDENCE_BYTE_LIMIT = 8 * 1024 * 1024;
const STORE = 'documents';
const RECORD_VERSION = 1;

export interface AuthorAnnotationPersistenceRecord extends AuthorAnnotationHydrationRecord {
  key: string;
  version: typeof RECORD_VERSION;
}

export interface AuthorAnnotationRepository {
  load(): Promise<readonly unknown[]>;
  replace(records: readonly AuthorAnnotationPersistenceRecord[]): Promise<void>;
  close(): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function point(value: unknown): boolean {
  return (
    object(value) && finite(value.x) && finite(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1
  );
}

function rect(value: unknown): boolean {
  return (
    point(value) && object(value) && finite(value.width) && finite(value.height) && value.width > 0 && value.height > 0
  );
}

function validAnchor(value: unknown): value is AuthorNativeAnchor {
  if (!object(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'text-range':
      return finite(value.startOffset) && finite(value.endOffset) && finite(value.startLine) && finite(value.endLine);
    case 'cell':
      return typeof value.fragmentId === 'string' && typeof value.location === 'string';
    case 'slide-element':
      return typeof value.fragmentId === 'string' && finite(value.slide) && typeof value.location === 'string';
    case 'image-rect':
      return rect(value.rect) && finite(value.naturalWidth) && finite(value.naturalHeight);
    case 'pdf-page-rect':
      return finite(value.page) && rect(value.rect);
    case 'video-time-rect':
      return finite(value.timeSeconds) && rect(value.rect);
    case 'story-preview-rect':
      return rect(value.rect) && object(value.preview);
    case 'image-point':
      return point(value.point) && finite(value.naturalWidth) && finite(value.naturalHeight);
    case 'pdf-page-point':
      return finite(value.page) && point(value.point);
    case 'video-time-point':
      return finite(value.timeSeconds) && point(value.point);
    case 'story-preview-point':
      return point(value.point) && object(value.preview);
    default:
      return false;
  }
}

function validEvidence(value: unknown): value is Blob | undefined {
  return (
    value === undefined ||
    (typeof Blob !== 'undefined' && value instanceof Blob && value.size <= AUTHOR_ANNOTATION_EVIDENCE_BYTE_LIMIT)
  );
}

function validCandidate(value: unknown): value is AuthorAnnotationCandidate {
  if (!object(value)) return false;
  return (
    typeof value.documentPath === 'string' &&
    normalizeAuthorPath(value.documentPath) !== '' &&
    finite(value.revision) &&
    (value.sourceSha256 === undefined || typeof value.sourceSha256 === 'string') &&
    (value.mode === undefined || value.mode === 'region' || value.mode === 'point') &&
    validAnchor(value.anchor) &&
    object(value.viewport) &&
    finite(value.viewport.width) &&
    finite(value.viewport.height) &&
    finite(value.createdAt) &&
    validEvidence(value.evidence)
  );
}

function validAnnotation(value: unknown): value is AuthorAnnotationDraft {
  return (
    validCandidate(value) &&
    object(value) &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.comment === 'string' &&
    value.comment.trim() !== '' &&
    (value.version === undefined || (Number.isInteger(value.version) && (value.version as number) >= 1))
  );
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateAuthorAnnotationRecord(input: unknown): AuthorAnnotationPersistenceRecord | undefined {
  if (!object(input) || input.version !== RECORD_VERSION || typeof input.key !== 'string') return undefined;
  if (typeof input.sessionId !== 'string' || input.sessionId === '' || typeof input.documentPath !== 'string')
    return undefined;
  const path = normalizeAuthorPath(input.documentPath);
  if (path === '' || input.key !== `${input.sessionId}\n${path}` || !object(input.collection)) return undefined;
  const collection = input.collection;
  if (
    !finite(collection.revision) ||
    (collection.sourceSha256 !== undefined && typeof collection.sourceSha256 !== 'string') ||
    typeof collection.stale !== 'boolean' ||
    typeof collection.candidateText !== 'string' ||
    utf8Length(collection.candidateText) > 2 * 1024 ||
    !Array.isArray(collection.annotations) ||
    collection.annotations.length > AUTHOR_REGION_LIMIT ||
    !collection.annotations.every(validAnnotation) ||
    (collection.candidate !== undefined && !validCandidate(collection.candidate)) ||
    !finite(collection.updatedAt)
  )
    return undefined;
  return input as unknown as AuthorAnnotationPersistenceRecord;
}

function durableCandidate<T extends AuthorAnnotationCandidate>(candidate: T): T {
  const { thumbnailUrl: _thumbnailUrl, ...durable } = candidate;
  return durable as T;
}

function persistenceRecords(): readonly AuthorAnnotationPersistenceRecord[] {
  const records: AuthorAnnotationPersistenceRecord[] = [];
  for (const [sessionId, session] of Object.entries(authorWorkspace.store.state.sessions)) {
    for (const [documentPath, collection] of Object.entries(session.annotationsByDocument)) {
      if (collection.annotations.length === 0 && collection.candidate === undefined && collection.candidateText === '')
        continue;
      records.push({
        key: `${sessionId}\n${documentPath}`,
        version: RECORD_VERSION,
        sessionId,
        documentPath,
        collection: {
          ...collection,
          candidate: collection.candidate && durableCandidate(collection.candidate),
          annotations: collection.annotations.map(durableCandidate),
        },
      });
    }
  }
  return records
    .sort((a, b) => b.collection.updatedAt - a.collection.updatedAt)
    .slice(0, AUTHOR_ANNOTATION_RECORD_LIMIT);
}

export class IndexedDbAuthorAnnotationRepository implements AuthorAnnotationRepository {
  readonly #database: Promise<IDBDatabase>;
  #writes: Promise<void> = Promise.resolve();

  constructor(factory: IDBFactory) {
    this.#database = new Promise((resolve, reject) => {
      const request = factory.open(AUTHOR_ANNOTATION_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open Author annotation storage.'));
    });
  }

  async load(): Promise<readonly unknown[]> {
    const database = await this.#database;
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to read Author annotations.'));
    });
  }

  replace(records: readonly AuthorAnnotationPersistenceRecord[]): Promise<void> {
    const write = async (): Promise<void> => {
      const database = await this.#database;
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        store.clear();
        records.forEach((record) => store.put(record));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to write Author annotations.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Author annotation write was aborted.'));
      });
    };
    this.#writes = this.#writes.catch(() => undefined).then(write);
    return this.#writes;
  }

  close(): void {
    void this.#database.then((database) => database.close()).catch(() => undefined);
  }
}

export function startAuthorAnnotationPersistence(repository?: AuthorAnnotationRepository): () => void {
  const factory = typeof indexedDB === 'undefined' ? undefined : indexedDB;
  if (repository === undefined && factory === undefined) return () => undefined;
  const storage = repository ?? new IndexedDbAuthorAnnotationRepository(factory!);
  let stopped = false;
  let hydrated = false;
  let dirty = false;
  const subscription = authorWorkspace.store.subscribe(() => {
    if (!hydrated) dirty = true;
    else void storage.replace(persistenceRecords()).catch(() => undefined);
  });
  void storage
    .load()
    .then((values) => {
      if (stopped) return;
      const records = values
        .map(validateAuthorAnnotationRecord)
        .filter((record): record is AuthorAnnotationPersistenceRecord => record !== undefined)
        .sort((a, b) => b.collection.updatedAt - a.collection.updatedAt)
        .slice(0, AUTHOR_ANNOTATION_RECORD_LIMIT);
      hydrateAuthorAnnotationCollections(records);
      hydrated = true;
      if (dirty || records.length > 0) void storage.replace(persistenceRecords()).catch(() => undefined);
    })
    .catch(() => {
      hydrated = true;
      if (dirty) void storage.replace(persistenceRecords()).catch(() => undefined);
    });
  return () => {
    stopped = true;
    subscription.unsubscribe();
    storage.close();
  };
}
