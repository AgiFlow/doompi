import fs from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import {
  parseStructuredDocument,
  preflightStructuredDocument,
  serializeStructuredDocument,
} from './structuredDocuments/index.ts';
import type { CsvDialect, DocumentOperation, StructuredDocumentFormat } from '../types/structuredDocuments.ts';

export const AUTHOR_DOCUMENT_OPEN_PATH = '/documents/open';
export const AUTHOR_DOCUMENT_PREFLIGHT_PATH = '/documents/preflight';
export const AUTHOR_DOCUMENT_SERIALIZE_PATH = '/documents/serialize';

interface DocumentRequest {
  path?: unknown;
  format?: unknown;
  operations?: unknown;
  preflightDigest?: unknown;
  csvDialect?: unknown;
}

export interface AuthorDocumentApiOptions {
  cwd?: string;
}

const FORMATS = new Set<StructuredDocumentFormat>(['markdown-slides', 'csv', 'pptx', 'xlsx']);

function errorResponse(
  context: { json: (value: unknown, status: 400 | 403 | 413 | 422 | 500) => Response },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : 'Document operation failed.';
  const status = /limit|too many|exceeds/i.test(message) ? 413 : /outside/i.test(message) ? 403 : 422;
  return context.json({ error: message }, status);
}

function requestFormat(value: unknown): StructuredDocumentFormat {
  if (typeof value !== 'string' || !FORMATS.has(value as StructuredDocumentFormat))
    throw new Error('A supported format is required.');
  return value as StructuredDocumentFormat;
}

function requestOperations(value: unknown): DocumentOperation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100_000) throw new Error('A bounded operations array is required.');
  return value.map((operation) => {
    if (
      typeof operation !== 'object' ||
      operation === null ||
      typeof (operation as Record<string, unknown>).fragmentId !== 'string' ||
      typeof (operation as Record<string, unknown>).replacement !== 'string'
    ) {
      throw new Error('Each operation requires string fragmentId and replacement fields.');
    }
    return operation as DocumentOperation;
  });
}

async function readDocument(cwd: string, requestedPath: unknown): Promise<Uint8Array> {
  if (
    typeof requestedPath !== 'string' ||
    requestedPath.length === 0 ||
    requestedPath.includes('\0') ||
    path.isAbsolute(requestedPath)
  ) {
    throw new Error('A relative document path is required.');
  }
  const root = await fs.realpath(cwd);
  const candidate = path.resolve(root, requestedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
    throw new Error('Document path is outside the working directory.');
  const realCandidate = await fs.realpath(candidate);
  if (realCandidate !== root && !realCandidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('Document path is outside the working directory.');
  }
  return await fs.readFile(realCandidate);
}

async function bodyOf(request: Request): Promise<DocumentRequest> {
  const body = (await request.json()) as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('A JSON object is required.');
  return body as DocumentRequest;
}

export function createAuthorDocumentApi(options: AuthorDocumentApiOptions = {}): Hono {
  const app = new Hono();
  const cwd = options.cwd ?? process.cwd();

  app.post(AUTHOR_DOCUMENT_OPEN_PATH, async (context) => {
    try {
      const body = await bodyOf(context.req.raw);
      const bytes = await readDocument(cwd, body.path);
      return context.json(
        await parseStructuredDocument(requestFormat(body.format), bytes, body.csvDialect as Partial<CsvDialect>),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post(AUTHOR_DOCUMENT_PREFLIGHT_PATH, async (context) => {
    try {
      const body = await bodyOf(context.req.raw);
      const bytes = await readDocument(cwd, body.path);
      return context.json(
        await preflightStructuredDocument(
          requestFormat(body.format),
          bytes,
          requestOperations(body.operations),
          body.csvDialect as Partial<CsvDialect>,
        ),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post(AUTHOR_DOCUMENT_SERIALIZE_PATH, async (context) => {
    try {
      const body = await bodyOf(context.req.raw);
      if (typeof body.preflightDigest !== 'string') throw new Error('A preflight report digest is required.');
      const bytes = await readDocument(cwd, body.path);
      const serialized = await serializeStructuredDocument(
        requestFormat(body.format),
        bytes,
        requestOperations(body.operations),
        body.preflightDigest,
        body.csvDialect as Partial<CsvDialect>,
      );
      return context.json({
        bytes: Buffer.from(serialized.bytes).toString('base64'),
        encoding: 'base64',
        manifest: serialized.manifest,
        operationLog: serialized.operationLog,
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  return app;
}
