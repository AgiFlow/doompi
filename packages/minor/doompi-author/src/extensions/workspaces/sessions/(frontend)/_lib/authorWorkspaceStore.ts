import { defineGlobalStore } from '@agimon-ai/doompi-core/web';

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
  activeTool: AuthorToolMode;
  annotationsByDocument: Readonly<Record<string, AuthorDocumentAnnotationCollection>>;
  /** Mixed annotations for the focused document. */
  annotations: readonly AuthorAnnotationDraft[];
  candidate?: AuthorRegionCandidate;
  candidateText: string;
  videoSeekRequest?: { path: string; generation: number; timeSeconds: number; sequence: number };
  /** Compatibility alias for annotations while region-only consumers migrate. */
  regions: readonly AuthorRegionDraft[];
  requests: readonly AuthorRequestRecord[];
}

export interface AuthorWorkspaceState {
  documents: Readonly<Record<string, AuthorWorkspaceDocument>>;
  sessions: Readonly<Record<string, AuthorSessionWorkspace>>;
}

const EMPTY_SESSION: AuthorSessionWorkspace = {
  generation: 0,
  activeTool: 'select',
  annotationsByDocument: {},
  annotations: [],
  candidateText: '',
  regions: [],
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

export function authorDocumentAnnotations(
  sessionId: string | null,
  path: string,
): AuthorDocumentAnnotationCollection | undefined {
  return sessionId === null
    ? undefined
    : authorWorkspace.store.state.sessions[sessionId]?.annotationsByDocument[normalizeAuthorPath(path)];
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
      const focused = session.focusedDocument;
      const visible = focused?.path === path && !stale;
      const annotations = visible ? collection.annotations : session.annotations;
      sessions = {
        ...sessions,
        [record.sessionId]: {
          ...session,
          annotationsByDocument: { ...session.annotationsByDocument, [path]: collection },
          ...(visible
            ? {
                annotations,
                regions: annotations,
                candidate: collection.candidate,
                candidateText: collection.candidateText,
              }
            : {}),
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
    if (sourceChanged && session?.focusedDocument?.path === path) {
      staleThumbnails.push(
        ...(session.candidate?.thumbnailUrl === undefined ? [] : [session.candidate.thumbnailUrl]),
        ...session.annotations.flatMap((annotation) =>
          annotation.thumbnailUrl === undefined ? [] : [annotation.thumbnailUrl],
        ),
      );
      const now = Date.now();
      const generation = session.generation + 1;
      const staleCollection = staleAuthorCollection(session.annotationsByDocument[path], now);
      sessions = {
        ...sessions,
        [sessionId]: {
          ...session,
          generation,
          focusedDocument: {
            path,
            generation,
            revision: baselineVersion,
            sourceSha256: input.sourceSha256,
            focusedAt: now,
          },
          annotationsByDocument: {
            ...session.annotationsByDocument,
            ...(staleCollection && { [path]: staleCollection }),
          },
          annotations: [],
          regions: [],
          candidate: undefined,
          candidateText: '',
          requests: session.requests.map((request) =>
            input.kind !== 'story-preview' &&
            request.documentPath === path &&
            (request.status === 'REQUESTED' || request.status === 'CHANGING' || request.status === 'CHANGED')
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
    } else if (sourceChanged && session?.annotationsByDocument[path] !== undefined) {
      const collection = session.annotationsByDocument[path];
      if (collection.candidate?.thumbnailUrl !== undefined) staleThumbnails.push(collection.candidate.thumbnailUrl);
      staleThumbnails.push(
        ...collection.annotations.flatMap((annotation) =>
          annotation.thumbnailUrl === undefined ? [] : [annotation.thumbnailUrl],
        ),
      );
      sessions = {
        ...sessions,
        [sessionId]: {
          ...session,
          annotationsByDocument: {
            ...session.annotationsByDocument,
            [path]: staleAuthorCollection(collection, Date.now())!,
          },
        },
      };
    }
    return { documents: { ...state.documents, [key]: result }, sessions };
  });
  staleThumbnails.forEach(revokeThumbnail);
  return result;
}

/** Claims focus and returns a generation token that makes cleanup race-safe. */
export function focusAuthorDocument(sessionId: string, path: string, revision: number, sourceSha256?: string): number {
  const normalized = normalizeAuthorPath(path);
  let generation = 0;
  authorWorkspace.update((state) => {
    const session = state.sessions[sessionId] ?? EMPTY_SESSION;
    generation = session.generation + 1;
    const stored = session.annotationsByDocument[normalized];
    const current =
      stored !== undefined && stored.revision === revision && stored.sourceSha256 === sourceSha256 && !stored.stale
        ? stored
        : undefined;
    const annotations = current?.annotations ?? [];
    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          generation,
          focusedDocument: {
            path: normalized,
            generation,
            revision,
            sourceSha256,
            focusedAt: Date.now(),
          },
          annotations,
          regions: annotations,
          candidate: current?.candidate,
          candidateText: current?.candidateText ?? '',
        },
      },
    };
  });
  return generation;
}

export function syncAuthorDocumentFocus(
  sessionId: string,
  generation: number,
  revision: number,
  sourceSha256?: string,
): void {
  updateSession(sessionId, (session) => {
    const focused = session.focusedDocument;
    if (focused === undefined || focused.generation !== generation) return session;
    if (focused.revision === revision && focused.sourceSha256 === sourceSha256) return session;
    return { ...session, focusedDocument: { ...focused, revision, sourceSha256 } };
  });
}

export function releaseAuthorDocumentFocus(sessionId: string, generation: number): void {
  updateSession(sessionId, (session) => {
    if (session.focusedDocument?.generation !== generation) return session;
    return {
      ...session,
      focusedDocument: undefined,
      candidate: undefined,
      candidateText: '',
      annotations: [],
      regions: [],
    };
  });
}

export function seekAuthorVideo(sessionId: string, timeSeconds: number): boolean {
  const workspace = authorSessionWorkspace(sessionId);
  const focused = workspace.focusedDocument;
  if (
    !focused ||
    workspace.candidate ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    authorDocument(sessionId, focused.path)?.kind !== 'video'
  )
    return false;
  updateSession(sessionId, (session) => ({
    ...session,
    activeTool: 'select',
    videoSeekRequest: {
      path: focused.path,
      generation: focused.generation,
      timeSeconds,
      sequence: (session.videoSeekRequest?.sequence ?? 0) + 1,
    },
  }));
  return true;
}

export function setAuthorToolMode(sessionId: string, activeTool: AuthorToolMode): void {
  updateSession(sessionId, (session) => (session.activeTool === activeTool ? session : { ...session, activeTool }));
}

export function setAuthorRegionCandidate(sessionId: string, candidate: AuthorRegionCandidate | undefined): void {
  let staleThumbnail: string | undefined;
  updateSession(sessionId, (session) => {
    const focused = session.focusedDocument;
    if (candidate !== undefined) {
      if (focused === undefined || focused.path !== normalizeAuthorPath(candidate.documentPath)) {
        throw new Error('The Author selection does not belong to the focused document.');
      }
      if (focused.revision !== candidate.revision || focused.sourceSha256 !== candidate.sourceSha256) {
        throw new Error('The Author selection is stale for the focused document.');
      }
    }
    if (focused === undefined) return session;
    staleThumbnail = session.candidate?.thumbnailUrl;
    const copied = candidate === undefined ? undefined : copyCandidate(candidate);
    return withFocusedCollection({ ...session, candidate: copied }, focused.path, { candidate: copied });
  });
  if (staleThumbnail !== undefined && staleThumbnail !== candidate?.thumbnailUrl) revokeThumbnail(staleThumbnail);
}

export const setAuthorAnnotationCandidate = setAuthorRegionCandidate;

export function setAuthorCandidateText(sessionId: string, candidateText: string): void {
  if (new TextEncoder().encode(candidateText).byteLength > 2 * 1024)
    throw new Error('Author candidate text must not exceed 2 KiB.');
  updateSession(sessionId, (session) => {
    const path = session.focusedDocument?.path;
    return path === undefined ? session : withFocusedCollection({ ...session, candidateText }, path, { candidateText });
  });
}

export function commitAuthorRegion(sessionId: string, comment: string): string {
  const id = crypto.randomUUID();
  const session = authorSessionWorkspace(sessionId);
  if (session.candidate === undefined) throw new Error('Select a document annotation before adding a comment.');
  addAuthorRegion(sessionId, { ...session.candidate, id, comment, version: 1 });
  updateSession(sessionId, (current) => {
    const path = current.focusedDocument?.path;
    return path === undefined
      ? current
      : withFocusedCollection({ ...current, candidate: undefined, candidateText: '' }, path, {
          candidate: undefined,
          candidateText: '',
        });
  });
  return id;
}

export const commitAuthorAnnotation = commitAuthorRegion;

export function addAuthorRegion(sessionId: string, region: AuthorRegionDraft): void {
  if (region.comment.trim() === '') throw new Error('Every Author annotation requires a comment.');
  updateSession(sessionId, (session) => {
    const focused = session.focusedDocument;
    if (focused === undefined || focused.path !== normalizeAuthorPath(region.documentPath)) {
      throw new Error('The Author annotation does not belong to the focused document.');
    }
    if (focused.revision !== region.revision || focused.sourceSha256 !== region.sourceSha256) {
      throw new Error('The Author annotation is stale for the focused document.');
    }
    if (session.annotations.length >= AUTHOR_REGION_LIMIT)
      throw new Error(`Author requests support at most ${AUTHOR_REGION_LIMIT} annotations.`);
    if (session.annotations.some((candidate) => candidate.id === region.id))
      throw new Error(`Author annotation '${region.id}' already exists.`);
    const annotations = [...session.annotations, copyRegion({ ...region, version: region.version ?? 1 })];
    return withFocusedCollection({ ...session, annotations, regions: annotations }, focused.path, { annotations });
  });
}

export const addAuthorAnnotationDraft = addAuthorRegion;

export function removeAuthorRegion(sessionId: string, regionId: string, expectedVersion?: number): void {
  let thumbnail: string | undefined;
  updateSession(sessionId, (session) => {
    const annotation = session.annotations.find((candidate) => candidate.id === regionId);
    if (annotation !== undefined && expectedVersion !== undefined && (annotation.version ?? 1) !== expectedVersion) {
      return session;
    }
    thumbnail = annotation?.thumbnailUrl;
    const annotations = session.annotations.filter((candidate) => candidate.id !== regionId);
    const path = session.focusedDocument?.path;
    return annotations.length === session.annotations.length || path === undefined
      ? session
      : withFocusedCollection({ ...session, annotations, regions: annotations }, path, { annotations });
  });
  if (thumbnail !== undefined) revokeThumbnail(thumbnail);
}

export const removeAuthorAnnotation = removeAuthorRegion;

export function updateAuthorRegionComment(sessionId: string, regionId: string, comment: string): void {
  if (comment.trim() === '') throw new Error('Every Author annotation requires a comment.');
  updateSession(sessionId, (session) => {
    const path = session.focusedDocument?.path;
    if (path === undefined) return session;
    const annotations = session.annotations.map((annotation) =>
      annotation.id === regionId ? { ...annotation, comment, version: (annotation.version ?? 1) + 1 } : annotation,
    );
    return withFocusedCollection({ ...session, annotations, regions: annotations }, path, { annotations });
  });
}

export const updateAuthorAnnotationComment = updateAuthorRegionComment;

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
    const focused = session?.focusedDocument;
    const identityChanged =
      focused?.path === document.path &&
      (focused.revision !== next.version || focused.sourceSha256 !== next.sourceSha256);
    if (identityChanged) {
      staleThumbnails.push(
        ...(session.candidate?.thumbnailUrl === undefined ? [] : [session.candidate.thumbnailUrl]),
        ...session.annotations.flatMap((annotation) =>
          annotation.thumbnailUrl === undefined ? [] : [annotation.thumbnailUrl],
        ),
      );
    }
    const staleCollection = identityChanged
      ? staleAuthorCollection(session.annotationsByDocument[document.path], Date.now())
      : undefined;
    const sessions = identityChanged
      ? {
          ...state.sessions,
          [sessionId]: {
            ...session,
            focusedDocument: { ...focused, revision: next.version, sourceSha256: next.sourceSha256 },
            annotationsByDocument: {
              ...session.annotationsByDocument,
              ...(staleCollection && { [document.path]: staleCollection }),
            },
            candidate: undefined,
            candidateText: '',
            annotations: [],
            regions: [],
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

function withFocusedCollection(
  session: AuthorSessionWorkspace,
  path: string,
  update: Partial<Pick<AuthorDocumentAnnotationCollection, 'annotations' | 'candidate' | 'candidateText'>>,
): AuthorSessionWorkspace {
  const focused = session.focusedDocument;
  if (focused === undefined || focused.path !== path) return session;
  const previous = session.annotationsByDocument[path];
  const collection: AuthorDocumentAnnotationCollection = {
    ...previous,
    revision: focused.revision,
    sourceSha256: focused.sourceSha256,
    stale: false,
    candidate: session.candidate,
    candidateText: session.candidateText,
    annotations: session.annotations,
    updatedAt: Date.now(),
    ...update,
  };
  return { ...session, annotationsByDocument: { ...session.annotationsByDocument, [path]: collection } };
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
