import { randomUUID } from 'node:crypto';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { Hono } from 'hono';
import { createAuthorBridgeState, type AuthorBridgeState } from '../services/authorBridgeState.ts';
import { API_BASE_PATH, AUTHOR_STATE_PATH, type AuthorSessionView } from '../types/authorApi.ts';
import { createAuthorBridgeApi } from './authorBridgeApi.ts';
import { createAuthorDocumentApi } from './authorDocumentApi.ts';

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
  app.get(AUTHOR_STATE_PATH, (context) =>
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
