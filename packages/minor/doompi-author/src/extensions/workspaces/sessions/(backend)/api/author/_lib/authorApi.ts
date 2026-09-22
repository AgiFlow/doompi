import { randomUUID } from 'node:crypto';

import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-core/packageApi';
import { Hono } from 'hono';

import { createAuthorBridgeState, type AuthorBridgeState } from '../../../../../../../models/authorBridgeState';
import type { AuthorCatalog } from '../../../../../../../services/authorCatalog/type';
import { readDocument } from '../../../../../../../services/structuredDocuments/document';
import routes from '../../../../../../../types/apiRoutes';
import { API_BASE_PATH, type AuthorSessionView } from '../../../../../../../types/authorApi';
import { createAuthorBridgeApi } from './authorBridgeApi';
import { createAuthorDocumentApi } from './authorDocumentApi';

export interface AuthorApiOptions {
  sessionId?: string;
  cwd?: string;
  readState?: () => Omit<AuthorSessionView, 'sessionId'>;
  bridge?: AuthorBridgeState;
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
  const bridge = options.bridge ?? createBridge();
  app.get(routes.state.path, (context) =>
    context.json({
      sessionId: options.sessionId ?? null,
      ...(options.readState ?? inactiveState)(),
    } satisfies AuthorSessionView),
  );
  app.route('/', createAuthorBridgeApi(bridge));
  app.route('/', createAuthorDocumentApi(options.cwd === undefined ? {} : { cwd: options.cwd }));
  return app;
}

export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    const bridge = createBridge();
    const app = createAuthorApi({
      ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
      bridge,
    });
    return { fetch: (request) => app.fetch(request), close: () => bridge.close() };
  },
};

/** The session API and tools share the same browser ownership and pending requests. */
export function createAuthorSessionApi(cwd: string, sessionId: string): { api: DoomApi; catalog: AuthorCatalog } {
  const bridge = createBridge();
  return {
    catalog: {
      async open(path, signal) {
        signal?.throwIfAborted();
        const bytes = await readDocument(cwd, path);
        return { path, byteLength: bytes.byteLength };
      },
      async describe(signal) {
        signal?.throwIfAborted();
        return bridge.describe();
      },
      execute: (input, signal) => bridge.invoke(input, signal),
    },
    api: {
      basePath: API_BASE_PATH,
      start() {
        const app = createAuthorApi({ cwd, sessionId, bridge });
        return { fetch: (request) => app.fetch(request), close: () => bridge.close() };
      },
    },
  };
}
