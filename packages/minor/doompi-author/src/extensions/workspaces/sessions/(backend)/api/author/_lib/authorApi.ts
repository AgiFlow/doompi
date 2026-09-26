import { randomUUID } from 'node:crypto';

import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';
import { Hono } from 'hono';

import { createAuthorBridgeState, type AuthorBridgeState } from '../../../../../../../models/authorBridgeState';
import {
  createAuthorCanvasRegistry,
  type AuthorCanvasRegistry,
} from '../../../../../../../services/authorCanvasRegistry';
import type { AuthorCatalog } from '../../../../../../../services/authorCatalog/type';
import routes from '../../../../../../../types/apiRoutes';
import { API_BASE_PATH, type AuthorSessionView } from '../../../../../../../types/authorApi';
import { createAuthorBridgeApi } from './authorBridgeApi';
import { createAuthorDocumentApi } from './authorDocumentApi';

export interface AuthorApiOptions {
  sessionId?: string;
  cwd?: string;
  readState?: () => Omit<AuthorSessionView, 'sessionId'>;
  registry?: AuthorCanvasRegistry;
}

const inactiveState = (): Omit<AuthorSessionView, 'sessionId'> => ({ activation: 'inactive', capabilityCount: 0 });
const createBridge = (): AuthorBridgeState =>
  createAuthorBridgeState({
    now: Date.now,
    issueToken: randomUUID,
    scheduleTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  });

export function createAuthorApi(options: AuthorApiOptions = {}): Hono {
  const app = new Hono();
  const registry = options.registry ?? createAuthorCanvasRegistry(options.cwd ?? process.cwd(), createBridge);
  app.get(routes.state.path, (context) =>
    context.json({
      sessionId: options.sessionId ?? null,
      ...(options.readState ?? inactiveState)(),
    } satisfies AuthorSessionView),
  );
  app.route('/', createAuthorBridgeApi(registry));
  app.route(
    '/',
    createAuthorDocumentApi({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      open: (path, signal, alias) => registry.open(path, signal, alias),
    }),
  );
  return app;
}

export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    const registry = createAuthorCanvasRegistry(context.cwd ?? process.cwd(), createBridge);
    const app = createAuthorApi({
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
      registry,
    });
    return { fetch: (request) => app.fetch(request), close: () => registry.dispose() };
  },
};

/** The session API and tools share the same browser ownership and pending requests. */
export function createAuthorSessionApi(
  cwd: string,
  sessionId: string,
): { api: DoomApi; catalog: AuthorCatalog; closeCanvases: () => void } {
  const registry = createAuthorCanvasRegistry(cwd, createBridge);
  return {
    closeCanvases: () => registry.closeAll(),
    catalog: {
      open: (path, signal, alias) => registry.open(path, signal, alias),
      async describe(signal, alias) {
        signal?.throwIfAborted();
        return registry.describe(alias);
      },
      execute: (input, signal) => registry.invoke(input, signal),
    },
    api: {
      basePath: API_BASE_PATH,
      start() {
        const app = createAuthorApi({ cwd, sessionId, registry });
        return { fetch: (request) => app.fetch(request), close: () => registry.dispose() };
      },
    },
  };
}
