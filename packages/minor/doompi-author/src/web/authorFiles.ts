import type {
  CsvDialect,
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
    const parsedDigest = parsed.manifest?.sourceDigest;
    if (sourceSha256 !== undefined && parsedDigest !== undefined && sourceSha256 !== parsedDigest) {
      throw new Error('Document source changed while opening. Reopen the document.');
    }
    const csvDialect = format === 'csv' ? csvDialectFromMetadata(parsed.manifest?.metadata) : undefined;
    return {
      path,
      kind,
      title: path.split('/').at(-1) ?? path,
      structuredFormat: format,
      fragments: parsed.fragments,
      ...(csvDialect === undefined ? {} : { csvDialect }),
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

function imageMimeType(path: string): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  return undefined;
}

async function croppedImageBytes(documentInput: AuthorDocumentInput, signal?: AbortSignal): Promise<Blob> {
  const { crop, mediaUrl } = documentInput;
  if (crop === undefined || mediaUrl === undefined) throw new Error('This Author image has no crop source.');
  const mimeType = imageMimeType(documentInput.path);
  if (mimeType === undefined) throw new Error('This image format cannot preserve its encoding after crop.');
  const response = await fetch(mediaUrl, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Author could not read the image before saving (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const sourceX = Math.round(crop.x * bitmap.width);
    const sourceY = Math.round(crop.y * bitmap.height);
    const sourceWidth = Math.max(1, Math.round(crop.width * bitmap.width));
    const sourceHeight = Math.max(1, Math.round(crop.height * bitmap.height));
    const canvas = window.document.createElement('canvas');
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas is unavailable for image crop.');
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType));
    if (blob === null || blob.type !== mimeType)
      throw new Error('The browser cannot encode this cropped image format.');
    return blob;
  } finally {
    bitmap.close();
  }
}

async function bytesToSave(sessionId: string, document: AuthorDocumentInput, signal?: AbortSignal): Promise<BodyInit> {
  if (document.kind === 'text' || document.kind === 'markdown') return document.content ?? '';
  if (document.kind === 'image' && document.crop !== undefined) return await croppedImageBytes(document, signal);
  if (document.structuredFormat === undefined) throw new Error('This Author view cannot be saved.');
  const operations = operationsFor(document);
  const request = {
    path: document.path,
    format: document.structuredFormat,
    operations,
    ...(document.csvDialect === undefined ? {} : { csvDialect: document.csvDialect }),
  };
  const preflight = await jsonRequest<DocumentPreflightReport>(
    authorDocumentApiUrl(sessionId, 'preflight'),
    request,
    signal,
  );
  if (preflight.sourceDigest !== undefined && preflight.sourceDigest !== document.sourceSha256) {
    throw new Error('Document source changed before saving. Reopen the document.');
  }
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

function csvDialectFromMetadata(
  metadata: Record<string, string | number | boolean> | undefined,
): CsvDialect | undefined {
  if (metadata === undefined) return undefined;
  const { delimiter, quote, recordDelimiter } = metadata;
  if (
    (delimiter !== ',' && delimiter !== ';' && delimiter !== '\t' && delimiter !== '|') ||
    (quote !== '"' && quote !== "'") ||
    (recordDelimiter !== '\n' && recordDelimiter !== '\r\n')
  ) {
    throw new Error('Author document API returned an invalid CSV dialect.');
  }
  return { delimiter, quote, recordDelimiter };
}

export function editableStructuredFragments(document: AuthorDocumentInput): readonly DocumentFragment[] {
  return document.fragments ?? [];
}
