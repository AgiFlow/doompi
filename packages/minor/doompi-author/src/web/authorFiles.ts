import type {
  DocumentFragment,
  DocumentOperation,
  DocumentPreflightReport,
  ParsedStructuredDocument,
  StructuredDocumentFormat,
} from '../types/structuredDocuments.ts';
import type { AuthorDocumentInput, AuthorDocumentKind } from './authorViewportTypes.ts';

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const VIDEO_EXTENSIONS = new Set(['m4v', 'mov', 'mp4', 'webm']);

function structuredFormat(path: string): StructuredDocumentFormat | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.slides.md')) return 'markdown-slides';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return undefined;
}

export function authorKindForPath(path: string): AuthorDocumentKind {
  const format = structuredFormat(path);
  if (format === 'markdown-slides') return 'slides';
  if (format !== undefined) return format;
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  if (extension === 'md') return 'markdown';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (extension === 'pdf') return 'pdf';
  if (['txt', 'json', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx'].includes(extension)) return 'text';
  return 'opaque';
}

export function authorSessionFileUrl(sessionId: string, path: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
}

function authorDocumentApiUrl(sessionId: string, operation: 'open' | 'preflight' | 'serialize'): string {
  return `/api/plugin/author/documents/${operation}?session=${encodeURIComponent(sessionId)}`;
}

async function jsonRequest<T>(url: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const value = (await response.json()) as T & { error?: unknown };
  if (!response.ok)
    throw new Error(typeof value.error === 'string' ? value.error : `Author document API failed (${response.status})`);
  return value;
}

export async function loadAuthorDocument(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<AuthorDocumentInput> {
  const kind = authorKindForPath(path);
  const url = authorSessionFileUrl(sessionId, path);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Author could not open ${path} (${response.status})`);
  const sourceSha256 = response.headers.get('X-File-SHA256') ?? undefined;
  const format = structuredFormat(path);
  if (format !== undefined) {
    const parsed = await jsonRequest<ParsedStructuredDocument>(
      authorDocumentApiUrl(sessionId, 'open'),
      { path, format },
      signal,
    );
    return {
      path,
      kind,
      title: path.split('/').at(-1) ?? path,
      structuredFormat: format,
      fragments: parsed.fragments,
      originalFragments: parsed.fragments.map((fragment) => ({ ...fragment })),
      ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    };
  }
  const mediaUrl = kind === 'image' || kind === 'video' || kind === 'pdf' || kind === 'opaque' ? url : undefined;
  const content = kind === 'text' || kind === 'markdown' ? await response.text() : undefined;
  return {
    path,
    kind,
    title: path.split('/').at(-1) ?? path,
    ...(content === undefined ? {} : { content }),
    ...(mediaUrl === undefined ? {} : { mediaUrl }),
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
  };
}

function operationsFor(document: AuthorDocumentInput): DocumentOperation[] {
  const originals = new Map((document.originalFragments ?? []).map((fragment) => [fragment.id, fragment.text]));
  return (document.fragments ?? [])
    .filter((fragment) => !fragment.readOnly && originals.get(fragment.id) !== fragment.text)
    .map((fragment) => ({ fragmentId: fragment.id, replacement: fragment.text }));
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value))
    throw new Error('Invalid serialized document bytes.');
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function bytesToSave(sessionId: string, document: AuthorDocumentInput, signal?: AbortSignal): Promise<BodyInit> {
  if (document.kind === 'text' || document.kind === 'markdown') return document.content ?? '';
  if (document.structuredFormat === undefined) throw new Error('This Author view cannot be saved.');
  const operations = operationsFor(document);
  const request = { path: document.path, format: document.structuredFormat, operations };
  const preflight = await jsonRequest<DocumentPreflightReport>(
    authorDocumentApiUrl(sessionId, 'preflight'),
    request,
    signal,
  );
  if (!preflight.accepted)
    throw new Error(preflight.issues.map((issue) => issue.message).join('\n') || 'Author preflight rejected the edit.');
  const serialized = await jsonRequest<{ bytes: string; encoding: string }>(
    authorDocumentApiUrl(sessionId, 'serialize'),
    { ...request, preflightDigest: preflight.digest },
    signal,
  );
  if (serialized.encoding !== 'base64') throw new Error('Author serialize returned an unsupported encoding.');
  const bytes = decodeBase64(serialized.bytes);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function saveAuthorDocument(
  sessionId: string,
  document: AuthorDocumentInput,
  signal?: AbortSignal,
): Promise<string> {
  if (document.sourceSha256 === undefined) throw new Error('This Author view has no source digest.');
  const response = await fetch(authorSessionFileUrl(sessionId, document.path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Expected-SHA256': document.sourceSha256 },
    body: await bytesToSave(sessionId, document, signal),
    signal,
  });
  if (!response.ok) throw new Error(`Author save failed (${response.status})`);
  const sha256 = response.headers.get('X-File-SHA256');
  if (sha256 === null || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Author save returned an invalid digest.');
  return sha256;
}

export function editableStructuredFragments(document: AuthorDocumentInput): readonly DocumentFragment[] {
  return document.fragments ?? [];
}
