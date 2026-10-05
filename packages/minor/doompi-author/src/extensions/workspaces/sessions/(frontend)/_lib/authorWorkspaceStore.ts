import { defineGlobalStore } from '@agimon-ai/doompi-core/web';

import type { AuthorPreviewSelection } from '../../../../../types/authorPreview';
import type {
  AuthorAnnotation,
  AuthorAnnotationCandidate,
  AuthorAnnotationDraft,
  AuthorCrop,
  AuthorDocumentInput,
  AuthorDraftRevision,
  AuthorFocusedDocument,
  AuthorRegionCandidate,
  AuthorRegionDraft,
  AuthorRequestRecord,
  AuthorRequestStatus,
  AuthorToolMode,
} from './authorViewportTypes';

export const AUTHOR_REGION_LIMIT = 16;
export const AUTHOR_HISTORY_RECORD_LIMIT = 100;
export const AUTHOR_HISTORY_BYTE_LIMIT = 512 * 1024;
const TERMINAL_REQUEST_STATUSES: ReadonlySet<AuthorRequestStatus> = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);

export interface AuthorWorkspaceDocument extends AuthorDocumentInput {
  path: string;
  annotations: readonly AuthorAnnotation[];
  revisions: readonly AuthorDraftRevision[];
  crop?: AuthorCrop;
  saveRequest: number;
  version: number;
  savedVersion: number;
  savingVersion?: number;
}

export interface AuthorDocumentAnnotationCollection {
  revision: number;
  sourceSha256?: string;
  stale: boolean;
  candidate?: AuthorAnnotationCandidate;
  candidateText: string;
  annotations: readonly AuthorAnnotationDraft[];
  updatedAt: number;
}

export interface AuthorSessionWorkspace {
  generation: number;
  focusedDocument?: AuthorFocusedDocument;
  annotationsByDocument: Readonly<Record<string, AuthorDocumentAnnotationCollection>>;
  toolsByDocument: Readonly<Record<string, AuthorToolMode>>;
  previewSelections?: Readonly<Record<string, AuthorPreviewSelection>>;
  videoSeekRequest?: { path: string; generation: number; timeSeconds: number; sequence: number };
  requests: readonly AuthorRequestRecord[];
}

export interface AuthorWorkspaceState {
  documents: Readonly<Record<string, AuthorWorkspaceDocument>>;
  sessions: Readonly<Record<string, AuthorSessionWorkspace>>;
}

const EMPTY_SESSION: AuthorSessionWorkspace = {
  generation: 0,
  annotationsByDocument: {},
  toolsByDocument: {},
  requests: [],
};

export function normalizeAuthorPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.trim().replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function authorDocumentKey(sessionId: string, path: string): string {
  return `${sessionId}\n${normalizeAuthorPath(path)}`;
}

export const authorWorkspace = defineGlobalStore<AuthorWorkspaceState>({ documents: {}, sessions: {} });

export function authorDocument(sessionId: string | null, path: string): AuthorWorkspaceDocument | undefined {
  if (sessionId === null) return undefined;
  return authorWorkspace.store.state.documents[authorDocumentKey(sessionId, path)];
}

export function authorSessionWorkspace(sessionId: string | null): AuthorSessionWorkspace {
  if (sessionId === null) return EMPTY_SESSION;
  return authorWorkspace.store.state.sessions[sessionId] ?? EMPTY_SESSION;
}

const EMPTY_COLLECTION: AuthorDocumentAnnotationCollection = Object.freeze({
  revision: 0,
  stale: false,
  candidate: undefined,
  candidateText: '',
  annotations: Object.freeze([]),
  updatedAt: 0,
});

export function authorDocumentAnnotations(
  sessionId: string | null,
  path: string,
  state: AuthorWorkspaceState = authorWorkspace.store.state,
): AuthorDocumentAnnotationCollection {
  if (sessionId === null) return EMPTY_COLLECTION;
  const document = state.documents[authorDocumentKey(sessionId, path)];
  const collection = state.sessions[sessionId]?.annotationsByDocument[normalizeAuthorPath(path)];
  return document !== undefined &&
    collection !== undefined &&
    !collection.stale &&
    collection.revision === document.version &&
    collection.sourceSha256 === document.sourceSha256
    ? collection
    : EMPTY_COLLECTION;
}

export interface AuthorAnnotationHydrationRecord {
  sessionId: string;
  documentPath: string;
  collection: AuthorDocumentAnnotationCollection;
}

export function hydrateAuthorAnnotationCollections(records: readonly AuthorAnnotationHydrationRecord[]): void {
  authorWorkspace.update((state) => {
    let sessions = state.sessions;
    for (const record of records) {
      const path = normalizeAuthorPath(record.documentPath);
      if (path === '') continue;
      const session = sessions[record.sessionId] ?? EMPTY_SESSION;
      const previous = session.annotationsByDocument[path];
      if (previous !== undefined && previous.updatedAt >= record.collection.updatedAt) continue;
      const document = state.documents[authorDocumentKey(record.sessionId, path)];
      const stale =
        record.collection.stale ||
        (document !== undefined &&
          (document.version !== record.collection.revision ||
            document.sourceSha256 !== record.collection.sourceSha256));
      const collection = restoreCollectionEvidence({ ...record.collection, stale });
      sessions = {
        ...sessions,
        [record.sessionId]: {
          ...session,
          annotationsByDocument: { ...session.annotationsByDocument, [path]: collection },
        },
      };
    }
    return sessions === state.sessions ? state : { ...state, sessions };
  });
}

export function putAuthorDocument(sessionId: string, input: AuthorDocumentInput): AuthorWorkspaceDocument {
  const path = normalizeAuthorPath(input.path);
  if (path === '') throw new Error('Author document path must not be empty');
  const key = authorDocumentKey(sessionId, path);
  const staleThumbnails: string[] = [];
  let result!: AuthorWorkspaceDocument;
  authorWorkspace.update((state) => {
    const previous = state.documents[key];
    const sourceChanged =
      previous?.sourceSha256 !== undefined &&
      input.sourceSha256 !== undefined &&
      previous.sourceSha256 !== input.sourceSha256;
    const baselineVersion = sourceChanged ? previous.version + 1 : (previous?.version ?? 0);
    result = {
      ...input,
      path,
      annotations: sourceChanged ? [] : (previous?.annotations ?? []),
      revisions: sourceChanged ? [] : (previous?.revisions ?? []),
      saveRequest: previous?.saveRequest ?? 0,
      version: baselineVersion,
      savedVersion: sourceChanged ? baselineVersion : (previous?.savedVersion ?? 0),
      ...(sourceChanged || previous?.crop === undefined ? {} : { crop: previous.crop }),
    };
    const session = state.sessions[sessionId];
    let sessions = state.sessions;
    if (sourceChanged && session !== undefined) {
      const collection = session.annotationsByDocument[path];
      if (collection?.candidate?.thumbnailUrl !== undefined) staleThumbnails.push(collection.candidate.thumbnailUrl);
      staleThumbnails.push(
        ...(collection?.annotations ?? []).flatMap((annotation) =>
          annotation.thumbnailUrl === undefined ? [] : [annotation.thumbnailUrl],
        ),
      );
      const now = Date.now();
      const staleCollection = staleAuthorCollection(collection, now);
      sessions = {
        ...sessions,
        [sessionId]: {
          ...session,
          annotationsByDocument: {
            ...session.annotationsByDocument,
            ...(staleCollection && { [path]: staleCollection }),
          },
          requests: session.requests.map((request) =>
            input.kind !== 'story-preview' &&
            request.documentPath === path &&
            ['REQUESTED', 'CHANGING', 'CHANGED'].includes(request.status)
              ? {
                  ...request,
                  status: 'FAILED',
                  currentOperation: undefined,
                  error: 'The document source changed before the request completed.',
                  updatedAt: now,
                }
              : request,
          ),
        },
      };
    }
    return { documents: { ...state.documents, [key]: result }, sessions };
  });
  staleThumbnails.forEach(revokeThumbnail);
  return result;
}

/** Claims focus and returns a generation token that makes cleanup race-safe. */
export function focusAuthorDocument(sessionId: string, path: string): number {
  let generation = 0;
  updateSession(sessionId, (session) => {
    generation = session.generation + 1;
    return {
      ...session,
      generation,
      focusedDocument: { path: normalizeAuthorPath(path), generation, focusedAt: Date.now() },
    };
  });
  return generation;
}

export function releaseAuthorDocumentFocus(sessionId: string, generation: number): void {
  updateSession(sessionId, (session) =>
    session.focusedDocument?.generation === generation ? { ...session, focusedDocument: undefined } : session,
  );
}

export function seekAuthorVideo(sessionId: string, path: string, timeSeconds: number): boolean {
  const normalized = normalizeAuthorPath(path);
  const focused = authorSessionWorkspace(sessionId).focusedDocument;
  if (
    focused?.path !== normalized ||
    authorDocumentAnnotations(sessionId, normalized).candidate ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    authorDocument(sessionId, normalized)?.kind !== 'video'
  )
    return false;
  setAuthorToolMode(sessionId, normalized, 'select');
  updateSession(sessionId, (session) => ({
    ...session,
    videoSeekRequest: {
      path: normalized,
      generation: focused.generation,
      timeSeconds,
      sequence: (session.videoSeekRequest?.sequence ?? 0) + 1,
    },
  }));
  return true;
}

export function authorToolMode(sessionId: string | null, path: string): AuthorToolMode {
  return authorSessionWorkspace(sessionId).toolsByDocument[normalizeAuthorPath(path)] ?? 'select';
}

export function setAuthorPreviewSelection(
  sessionId: string,
  path: string,
  preview: AuthorPreviewSelection | undefined,
): void {
  const normalized = normalizeAuthorPath(path);
  updateSession(sessionId, (session) => {
    const selections = { ...session.previewSelections };
    if (preview === undefined) delete selections[normalized];
    else selections[normalized] = { ...preview };
    return { ...session, previewSelections: selections };
  });
}

export function setAuthorToolMode(sessionId: string, path: string, tool: AuthorToolMode): void {
  const normalized = normalizeAuthorPath(path);
  updateSession(sessionId, (session) => ({
    ...session,
    toolsByDocument: { ...session.toolsByDocument, [normalized]: tool },
  }));
}

function validateCandidate(sessionId: string, path: string, candidate: AuthorRegionCandidate): void {
  const document = authorDocument(sessionId, path);
  if (document === undefined || normalizeAuthorPath(candidate.documentPath) !== normalizeAuthorPath(path))
    throw new Error('The Author selection does not belong to the document.');
  if (document.version !== candidate.revision || document.sourceSha256 !== candidate.sourceSha256)
    throw new Error('The Author selection is stale for the document.');
}

export function setAuthorRegionCandidate(
  sessionId: string,
  path: string,
  candidate: AuthorRegionCandidate | undefined,
): void {
  if (candidate !== undefined) validateCandidate(sessionId, path, candidate);
  const thumbnail = authorDocumentAnnotations(sessionId, path).candidate?.thumbnailUrl;
  updateCollection(sessionId, path, (collection) => ({
    ...collection,
    candidate: candidate && copyCandidate(candidate),
  }));
  if (thumbnail !== undefined && thumbnail !== candidate?.thumbnailUrl) revokeThumbnail(thumbnail);
}

export function setAuthorCandidateText(sessionId: string, path: string, candidateText: string): void {
  if (new TextEncoder().encode(candidateText).byteLength > 2 * 1024)
    throw new Error('Author candidate text must not exceed 2 KiB.');
  updateCollection(sessionId, path, (collection) => ({ ...collection, candidateText }));
}

export function commitAuthorRegion(sessionId: string, path: string, comment: string): string {
  const candidate = authorDocumentAnnotations(sessionId, path).candidate;
  if (candidate === undefined) throw new Error('Select a document annotation before adding a comment.');
  const id = crypto.randomUUID();
  addAuthorRegion(sessionId, { ...candidate, id, comment, version: 1 });
  updateCollection(sessionId, path, (collection) => ({ ...collection, candidate: undefined, candidateText: '' }));
  return id;
}

export function addAuthorRegion(sessionId: string, region: AuthorRegionDraft): void {
  if (region.comment.trim() === '') throw new Error('Every Author annotation requires a comment.');
  validateCandidate(sessionId, region.documentPath, region);
  updateCollection(sessionId, region.documentPath, (collection) => {
    if (collection.annotations.length >= AUTHOR_REGION_LIMIT)
      throw new Error(`Author requests support at most ${AUTHOR_REGION_LIMIT} annotations.`);
    if (collection.annotations.some((candidate) => candidate.id === region.id))
      throw new Error(`Author annotation '${region.id}' already exists.`);
    return {
      ...collection,
      annotations: [...collection.annotations, copyRegion({ ...region, version: region.version ?? 1 })],
    };
  });
}

export function removeAuthorRegion(sessionId: string, path: string, regionId: string, expectedVersion?: number): void {
  let thumbnail: string | undefined;
  updateCollection(sessionId, path, (collection) => {
    const annotation = collection.annotations.find((candidate) => candidate.id === regionId);
    if (annotation === undefined || (expectedVersion !== undefined && (annotation.version ?? 1) !== expectedVersion))
      return collection;
    thumbnail = annotation.thumbnailUrl;
    return { ...collection, annotations: collection.annotations.filter((candidate) => candidate.id !== regionId) };
  });
  if (thumbnail !== undefined) revokeThumbnail(thumbnail);
}

export function updateAuthorRegionComment(sessionId: string, path: string, regionId: string, comment: string): void {
  if (comment.trim() === '') throw new Error('Every Author annotation requires a comment.');
  updateCollection(sessionId, path, (collection) => ({
    ...collection,
    annotations: collection.annotations.map((annotation) =>
      annotation.id === regionId ? { ...annotation, comment, version: (annotation.version ?? 1) + 1 } : annotation,
    ),
  }));
}

export function putAuthorRequest(sessionId: string, record: AuthorRequestRecord): void {
  if (record.requestText.trim() === '') throw new Error('An Author request requires verbatim request text.');
  if (record.regions.length === 0 || record.regions.some((region) => region.comment.trim() === '')) {
    throw new Error('An Author request requires at least one commented region.');
  }
  updateSession(sessionId, (session) => {
    if (session.requests.some((request) => request.id === record.id))
      throw new Error(`Author request '${record.id}' already exists.`);
    return { ...session, requests: boundHistory([...session.requests, copyRequest(record)]) };
  });
}

export function updateAuthorRequest(
  sessionId: string,
  requestId: string,
  update: (record: AuthorRequestRecord) => AuthorRequestRecord,
): void {
  updateSession(sessionId, (session) => ({
    ...session,
    requests: boundHistory(
      session.requests.map((request) => (request.id === requestId ? copyRequest(update(request)) : request)),
    ),
  }));
}

export function reviseAuthorDocument(sessionId: string, path: string, content: string): void {
  updateDocument(sessionId, path, (document) => {
    if (document.content === content) return document;
    const version = document.version + 1;
    return {
      ...document,
      content,
      version,
      revisions: [...document.revisions, { revision: version, content }],
    };
  });
}

export function reviseAuthorFragment(sessionId: string, path: string, fragmentId: string, text: string): void {
  updateDocument(sessionId, path, (document) => {
    const fragment = document.fragments?.find((candidate) => candidate.id === fragmentId);
    if (fragment === undefined || fragment.text === text) return document;
    const version = document.version + 1;
    return {
      ...document,
      fragments: document.fragments?.map((fragment) => (fragment.id === fragmentId ? { ...fragment, text } : fragment)),
      version,
      revisions: [...document.revisions, { revision: version, content: text }],
    };
  });
}

export function addAuthorAnnotation(sessionId: string, path: string, annotation: AuthorAnnotation): void {
  updateDocument(sessionId, path, (document) => ({ ...document, annotations: [...document.annotations, annotation] }));
}

export function setAuthorCrop(sessionId: string, path: string, crop: AuthorCrop | undefined): void {
  updateDocument(sessionId, path, (document) => {
    const version = document.version + 1;
    return {
      ...document,
      ...(crop === undefined ? { crop: undefined } : { crop }),
      version,
      revisions: [...document.revisions, { revision: version, content: JSON.stringify(crop ?? null) }],
    };
  });
}

export function requestAuthorSave(sessionId: string, path: string): void {
  updateDocument(sessionId, path, (document) => ({
    ...document,
    saveRequest: document.saveRequest + 1,
    savingVersion: document.version,
  }));
}

export function failAuthorSave(sessionId: string, path: string, savingVersion: number): void {
  updateDocument(sessionId, path, (document) =>
    document.savingVersion === savingVersion ? { ...document, savingVersion: undefined } : document,
  );
}

export function completeAuthorSave(
  sessionId: string,
  path: string,
  sourceSha256: string,
  savedVersion: number,
  savedFragments: AuthorDocumentInput['fragments'],
): void {
  updateDocument(sessionId, path, (document) => {
    if (savedVersion < document.savedVersion) return document;
    return {
      ...document,
      sourceSha256,
      savedVersion,
      savingVersion: document.savingVersion === savedVersion ? undefined : document.savingVersion,
      originalFragments: savedFragments?.map((fragment) => ({ ...fragment })),
      ...(document.version === savedVersion ? { crop: undefined } : {}),
      revisions: document.revisions.filter((revision) => revision.revision > savedVersion),
    };
  });
  const now = Date.now();
  updateSession(sessionId, (session) => ({
    ...session,
    requests: boundHistory(
      session.requests.map((request) =>
        request.documentPath === normalizeAuthorPath(path) &&
        request.status === 'CHANGED' &&
        request.revision <= savedVersion
          ? { ...request, status: 'COMPLETE', currentOperation: undefined, updatedAt: now }
          : request,
      ),
    ),
  }));
}

export function dropAuthorSession(sessionId: string): void {
  const prefix = `${sessionId}\n`;
  const session = authorWorkspace.store.state.sessions[sessionId];
  for (const collection of Object.values(session?.annotationsByDocument ?? {})) {
    if (collection.candidate?.thumbnailUrl !== undefined) revokeThumbnail(collection.candidate.thumbnailUrl);
    collection.annotations.forEach((annotation) => {
      if (annotation.thumbnailUrl !== undefined) revokeThumbnail(annotation.thumbnailUrl);
    });
  }
  authorWorkspace.update((state) => {
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return {
      documents: Object.fromEntries(Object.entries(state.documents).filter(([key]) => !key.startsWith(prefix))),
      sessions,
    };
  });
}

export function setAuthorStoryPreview(
  sessionId: string,
  path: string,
  storyPreview: NonNullable<AuthorWorkspaceDocument['storyPreview']>,
): void {
  updateDocument(sessionId, path, (document) => ({ ...document, storyPreview: structuredClone(storyPreview) }));
}

function updateDocument(
  sessionId: string,
  path: string,
  update: (document: AuthorWorkspaceDocument) => AuthorWorkspaceDocument,
): void {
  const key = authorDocumentKey(sessionId, path);
  const staleThumbnails: string[] = [];
  authorWorkspace.update((state) => {
    const document = state.documents[key];
    if (document === undefined) return state;
    const next = update(document);
    const session = state.sessions[sessionId];
    const identityChanged = document.version !== next.version || document.sourceSha256 !== next.sourceSha256;
    const collection = identityChanged ? session?.annotationsByDocument[document.path] : undefined;
    if (collection !== undefined) {
      if (collection.candidate?.thumbnailUrl !== undefined) staleThumbnails.push(collection.candidate.thumbnailUrl);
      staleThumbnails.push(
        ...collection.annotations.flatMap((annotation) =>
          annotation.thumbnailUrl === undefined ? [] : [annotation.thumbnailUrl],
        ),
      );
    }
    const staleCollection = identityChanged ? staleAuthorCollection(collection, Date.now()) : undefined;
    const sessions =
      identityChanged && session !== undefined
        ? {
            ...state.sessions,
            [sessionId]: {
              ...session,
              annotationsByDocument: {
                ...session.annotationsByDocument,
                ...(staleCollection && { [document.path]: staleCollection }),
              },
            },
          }
        : state.sessions;
    return { documents: { ...state.documents, [key]: next }, sessions };
  });
  staleThumbnails.forEach(revokeThumbnail);
}

function updateSession(sessionId: string, update: (session: AuthorSessionWorkspace) => AuthorSessionWorkspace): void {
  authorWorkspace.update((state) => {
    const session = state.sessions[sessionId] ?? EMPTY_SESSION;
    const next = update(session);
    return next === session ? state : { ...state, sessions: { ...state.sessions, [sessionId]: next } };
  });
}

function copyCandidate<T extends AuthorAnnotationCandidate>(candidate: T): T {
  const anchor =
    'rect' in candidate.anchor
      ? { ...candidate.anchor, rect: { ...candidate.anchor.rect } }
      : 'point' in candidate.anchor
        ? { ...candidate.anchor, point: { ...candidate.anchor.point } }
        : { ...candidate.anchor };
  return {
    ...candidate,
    anchor,
    viewport: { ...candidate.viewport },
    stroke: candidate.stroke?.map((point) => ({ ...point })),
    voiceGrid: candidate.voiceGrid && { ...candidate.voiceGrid },
  };
}

function copyRegion(region: AuthorRegionDraft): AuthorRegionDraft {
  return copyCandidate(region);
}

function staleAuthorCollection(
  collection: AuthorDocumentAnnotationCollection | undefined,
  updatedAt: number,
): AuthorDocumentAnnotationCollection | undefined {
  if (collection === undefined) return undefined;
  return {
    ...collection,
    stale: true,
    candidate: collection.candidate && { ...copyCandidate(collection.candidate), thumbnailUrl: undefined },
    annotations: collection.annotations.map((annotation) => ({ ...copyRegion(annotation), thumbnailUrl: undefined })),
    updatedAt,
  };
}

function updateCollection(
  sessionId: string,
  path: string,
  update: (collection: AuthorDocumentAnnotationCollection) => AuthorDocumentAnnotationCollection,
): void {
  const normalized = normalizeAuthorPath(path);
  const document = authorDocument(sessionId, normalized);
  if (document === undefined) return;
  updateSession(sessionId, (session) => {
    const current = authorDocumentAnnotations(sessionId, normalized);
    const base =
      current === EMPTY_COLLECTION
        ? { ...EMPTY_COLLECTION, revision: document.version, sourceSha256: document.sourceSha256 }
        : current;
    const next = update(base);
    if (next === base) return session;
    return {
      ...session,
      annotationsByDocument: {
        ...session.annotationsByDocument,
        [normalized]: { ...next, stale: false, updatedAt: Date.now() },
      },
    };
  });
}

function boundedHistoryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= 16 * 1024) return value;
  let end = value.length;
  while (end > 0 && encoder.encode(value.slice(0, end)).byteLength > 16 * 1024) end -= 256;
  return value.slice(0, end);
}

function copyRequest(record: AuthorRequestRecord): AuthorRequestRecord {
  return {
    ...record,
    before: boundedHistoryText(record.before),
    after: boundedHistoryText(record.after),
    regions: record.regions.map(copyRegion),
    pendingRegions: record.pendingRegions?.map(copyRegion),
  };
}

function boundHistory(records: readonly AuthorRequestRecord[]): readonly AuthorRequestRecord[] {
  const next = [...records];
  const bytes = (): number => new TextEncoder().encode(JSON.stringify(next)).byteLength;
  while (next.length > AUTHOR_HISTORY_RECORD_LIMIT || bytes() > AUTHOR_HISTORY_BYTE_LIMIT) {
    const terminal = next.findIndex((record) => TERMINAL_REQUEST_STATUSES.has(record.status));
    if (terminal < 0) throw new Error('Author request history is full while active requests are still running.');
    next.splice(terminal, 1);
  }
  return next;
}

function restoreCollectionEvidence(collection: AuthorDocumentAnnotationCollection): AuthorDocumentAnnotationCollection {
  const restore = <T extends AuthorAnnotationCandidate>(item: T): T => {
    const copied = copyCandidate(item);
    const existingVersion: unknown = Reflect.get(copied, 'version');
    const versioned =
      'id' in copied
        ? ({ ...copied, version: typeof existingVersion === 'number' ? existingVersion : 1 } as T)
        : copied;
    if (versioned.thumbnailUrl !== undefined || versioned.evidence === undefined) return versioned;
    try {
      return { ...versioned, thumbnailUrl: URL.createObjectURL(versioned.evidence) };
    } catch {
      return versioned;
    }
  };
  return {
    ...collection,
    candidate: collection.candidate && restore(collection.candidate),
    annotations: collection.annotations.map(restore),
  };
}

function revokeThumbnail(url: string): void {
  if (!url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Thumbnail cleanup must not make session teardown fail.
  }
}
