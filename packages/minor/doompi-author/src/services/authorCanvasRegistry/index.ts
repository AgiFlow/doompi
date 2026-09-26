import fs from 'node:fs/promises';
import path from 'node:path';

import { AuthorBridgeError, type AuthorBridgeState } from '../../models/authorBridgeState';
import { AUTHOR_ALIAS_PATTERN } from '../../schemas/authorTools';
import type {
  AuthorCanvasView,
  AuthorOpenFileResult,
  AuthorViewportCatalogSnapshot,
  UseAuthorToolInput,
} from '../../types/author';
import { readDocument } from '../structuredDocuments/document';

interface Canvas {
  alias: string;
  path: string;
  realPath: string;
  bridge: AuthorBridgeState;
  closed: boolean;
  readyOnce: boolean;
}

const MAX_CANVASES = 32;

export function createAuthorCanvasRegistry(cwd: string, createBridge: () => AuthorBridgeState) {
  const byAlias = new Map<string, Canvas>();
  const byPath = new Map<string, Canvas>();

  const select = (alias?: string): Canvas => {
    if (alias !== undefined) {
      if (!AUTHOR_ALIAS_PATTERN.test(alias)) throw new AuthorBridgeError('Invalid Author canvas alias.', 400);
      const canvas = byAlias.get(alias);
      if (canvas === undefined)
        throw new AuthorBridgeError(
          `Unknown Author canvas '${alias}'. Call describe_author_tools({}) for available aliases.`,
          404,
        );
      return canvas;
    }
    const canvases = [...byAlias.values()].filter((canvas) => !canvas.closed);
    if (canvases.length !== 1)
      throw new AuthorBridgeError('Specify a canvas alias. Call describe_author_tools({}) to list canvases.', 409);
    return canvases[0]!;
  };

  const view = (canvas: Canvas): AuthorCanvasView => {
    if (canvas.closed) return { alias: canvas.alias, path: canvas.path, status: 'unavailable' };
    try {
      canvas.bridge.describe();
      canvas.readyOnce = true;
      return { alias: canvas.alias, path: canvas.path, status: 'ready' };
    } catch {
      return { alias: canvas.alias, path: canvas.path, status: canvas.readyOnce ? 'unavailable' : 'opening' };
    }
  };

  return {
    async open(requestedPath: string, signal?: AbortSignal, requestedAlias?: string): Promise<AuthorOpenFileResult> {
      signal?.throwIfAborted();
      if (requestedAlias !== undefined && !AUTHOR_ALIAS_PATTERN.test(requestedAlias))
        throw new AuthorBridgeError('Invalid Author canvas alias.', 400);
      const bytes = await readDocument(cwd, requestedPath);
      signal?.throwIfAborted();
      const root = await fs.realpath(cwd);
      const realPath = await fs.realpath(path.resolve(root, requestedPath));
      if (realPath !== root && !realPath.startsWith(`${root}${path.sep}`))
        throw new AuthorBridgeError('Document path is outside the working directory.', 400);
      const canonicalPath = path.relative(root, realPath).split(path.sep).join('/');
      const occupied = requestedAlias === undefined ? undefined : byAlias.get(requestedAlias);
      if (occupied !== undefined && occupied.realPath !== realPath)
        throw new AuthorBridgeError(`Author canvas alias '${requestedAlias}' already names ${occupied.path}.`, 409);
      const existing = byPath.get(realPath);
      if (existing !== undefined) {
        if (existing.closed) existing.readyOnce = false;
        existing.closed = false;
        return {
          path: existing.path,
          byteLength: bytes.byteLength,
          alias: existing.alias,
          status: view(existing).status,
          reused: true,
        };
      }
      if (byAlias.size >= MAX_CANVASES)
        throw new AuthorBridgeError('Too many Author canvases in this conversation.', 409);
      const base =
        path
          .basename(canonicalPath)
          .replace(/\.[^.]*$/u, '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/gu, '-')
          .replace(/^[^a-z]+/u, 'canvas-')
          .slice(0, 48) || 'canvas';
      let alias = requestedAlias ?? base;
      for (let suffix = 2; byAlias.has(alias); suffix++) alias = `${base.slice(0, 56)}-${suffix}`;
      const canvas: Canvas = {
        alias,
        path: canonicalPath,
        realPath,
        bridge: createBridge(),
        closed: false,
        readyOnce: false,
      };
      byAlias.set(alias, canvas);
      byPath.set(realPath, canvas);
      return { path: canonicalPath, byteLength: bytes.byteLength, alias, status: 'opening', reused: false };
    },
    describe(alias?: string): AuthorViewportCatalogSnapshot {
      const canvases = [...byAlias.values()].map(view);
      const target =
        alias === undefined && canvases.filter((canvas) => canvas.status !== 'unavailable').length !== 1
          ? undefined
          : select(alias);
      if (target === undefined) {
        return {
          catalogToken: '',
          tools: [],
          canvases,
          nextStep: 'Open a file with open_authoring_file, then describe_author_tools({"alias":"canvas-name"}).',
        };
      }
      const status = view(target).status;
      const base = { alias: target.alias, path: target.path, status, canvases };
      if (status !== 'ready') {
        return {
          ...base,
          catalogToken: '',
          tools: [],
          nextStep:
            status === 'opening'
              ? `Wait for ${target.alias} to be ready, then call describe_author_tools({"alias":"${target.alias}"}).`
              : `Reopen ${target.path} with open_authoring_file({"path":"${target.path}","alias":"${target.alias}"}).`,
        };
      }
      return { ...base, ...target.bridge.describe() };
    },
    invoke(input: UseAuthorToolInput, signal?: AbortSignal) {
      const target = select(input.alias);
      if (target.closed) throw new AuthorBridgeError(`Canvas '${target.alias}' is closed. Reopen its file.`, 503);
      return target.bridge.invoke(input, signal).then((result) => ({ ...result, alias: target.alias }));
    },
    bridge(alias: string): AuthorBridgeState {
      const canvas = select(alias);
      if (canvas.closed) throw new AuthorBridgeError(`Canvas '${alias}' is closed. Reopen its file.`, 503);
      return canvas.bridge;
    },
    close(alias: string): void {
      const canvas = select(alias);
      canvas.closed = true;
      canvas.bridge.close();
      canvas.bridge = createBridge();
    },
    closeAll(): void {
      for (const canvas of byAlias.values()) {
        if (canvas.closed) continue;
        canvas.closed = true;
        canvas.bridge.close();
        canvas.bridge = createBridge();
      }
    },
    dispose(): void {
      for (const canvas of byAlias.values()) canvas.bridge.close();
      byAlias.clear();
      byPath.clear();
    },
  };
}

export type AuthorCanvasRegistry = ReturnType<typeof createAuthorCanvasRegistry>;
