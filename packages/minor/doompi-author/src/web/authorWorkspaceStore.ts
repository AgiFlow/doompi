import { defineGlobalStore } from '@agimon-ai/doompi-web-contracts';
import type { AuthorAnnotation, AuthorCrop, AuthorDocumentInput, AuthorDraftRevision } from './authorViewportTypes.ts';

export interface AuthorWorkspaceDocument extends AuthorDocumentInput {
  path: string;
  annotations: readonly AuthorAnnotation[];
  revisions: readonly AuthorDraftRevision[];
  crop?: AuthorCrop;
  saveRequest: number;
  version: number;
  savedVersion: number;
}

interface AuthorWorkspaceState {
  documents: Readonly<Record<string, AuthorWorkspaceDocument>>;
}

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

export const authorWorkspace = defineGlobalStore<AuthorWorkspaceState>({ documents: {} });

export function authorDocument(sessionId: string | null, path: string): AuthorWorkspaceDocument | undefined {
  if (sessionId === null) return undefined;
  return authorWorkspace.store.state.documents[authorDocumentKey(sessionId, path)];
}

export function putAuthorDocument(sessionId: string, input: AuthorDocumentInput): AuthorWorkspaceDocument {
  const path = normalizeAuthorPath(input.path);
  if (path === '') throw new Error('Author document path must not be empty');
  const key = authorDocumentKey(sessionId, path);
  let result!: AuthorWorkspaceDocument;
  authorWorkspace.update((state) => {
    const previous = state.documents[key];
    result = {
      ...input,
      path,
      annotations: previous?.annotations ?? [],
      revisions: previous?.revisions ?? [],
      saveRequest: previous?.saveRequest ?? 0,
      version: previous?.version ?? 0,
      savedVersion: previous?.savedVersion ?? 0,
      ...(previous?.crop === undefined ? {} : { crop: previous.crop }),
    };
    return { documents: { ...state.documents, [key]: result } };
  });
  return result;
}

export function reviseAuthorDocument(sessionId: string, path: string, content: string): void {
  updateDocument(sessionId, path, (document) => {
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
  updateDocument(sessionId, path, (document) => ({
    ...document,
    ...(crop === undefined ? { crop: undefined } : { crop }),
  }));
}

export function requestAuthorSave(sessionId: string, path: string): void {
  updateDocument(sessionId, path, (document) => ({ ...document, saveRequest: document.saveRequest + 1 }));
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
      originalFragments: savedFragments?.map((fragment) => ({ ...fragment })),
      revisions: document.revisions.filter((revision) => revision.revision > savedVersion),
    };
  });
}

export function dropAuthorSession(sessionId: string): void {
  const prefix = `${sessionId}\n`;
  authorWorkspace.update((state) => ({
    documents: Object.fromEntries(Object.entries(state.documents).filter(([key]) => !key.startsWith(prefix))),
  }));
}

function updateDocument(
  sessionId: string,
  path: string,
  update: (document: AuthorWorkspaceDocument) => AuthorWorkspaceDocument,
): void {
  const key = authorDocumentKey(sessionId, path);
  authorWorkspace.update((state) => {
    const document = state.documents[key];
    if (document === undefined) return state;
    return { documents: { ...state.documents, [key]: update(document) } };
  });
}
