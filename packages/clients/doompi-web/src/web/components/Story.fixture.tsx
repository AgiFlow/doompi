import { TooltipProvider } from '@agimon-ai/doompi-web-components';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import { sealedHttpSession } from '../lib/sealedSession.ts';
import { initialSessionState, type SessionState } from '../lib/sessionModel.ts';
import { bindTransport } from '../lib/transport.ts';
import { sessionsStore, type SessionMeta } from '../stores/sessionsStore.ts';
import { sessionStoreFor } from '../stores/sessionStore.ts';
import { workspacesStore } from '../stores/workspacesStore.ts';

/** Only imported by stories. Unknown requests fail closed instead of reaching a real hub. */
export function mockStoryRequests(responses: Readonly<Record<string, unknown>> = {}): void {
  const request = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, 'https://story.invalid');
    const method = init?.method?.toUpperCase() ?? 'GET';
    const key = `${method} ${url.pathname}${url.search}`;
    const fallback = `${method} ${url.pathname}`;
    const body = responses[key] ?? responses[fallback];
    if (body instanceof Response) return body.clone();
    return body === undefined
      ? Response.json({ error: `No story response for ${key}.` }, { status: 503 })
      : Response.json(body);
  };
  sealedHttpSession.fetch = request;
  globalThis.fetch = (input, init) =>
    request(input instanceof Request ? input.url : String(input), {
      ...(input instanceof Request ? { method: input.method } : {}),
      ...init,
    });
  bindTransport(
    () => undefined,
    async () => {
      throw new Error('Server methods are unavailable in isolated stories.');
    },
  );
}

mockStoryRequests();

export const STORY_SESSION_ID = 'story-session';
export const STORY_WORKSPACE_ID = 'story-workspace';

export function seedStorySession(patch: Partial<SessionState> = {}, metaPatch: Partial<SessionMeta> = {}): void {
  const timestamp = '2026-09-01T10:00:00.000Z';
  const meta: SessionMeta = {
    summary: {
      id: STORY_SESSION_ID,
      workspaceId: STORY_WORKSPACE_ID,
      name: 'Review component stories',
      cwd: '/workspace/doompi',
      createdAt: timestamp,
      updatedAt: timestamp,
      phase: 'idle',
      phaseSince: timestamp,
      attach: 'attached',
      pendingMessageCount: 0,
      everPrompted: true,
      awaitingInput: false,
    },
    attach: 'attached',
    reason: '',
    replayed: 0,
    dropped: 0,
    ...metaPatch,
  };
  sessionsStore.setState(() => ({
    order: [STORY_SESSION_ID],
    byId: { [STORY_SESSION_ID]: meta },
    activeId: STORY_SESSION_ID,
    transferringToId: null,
    hydrated: true,
  }));
  workspacesStore.setState(() => ({
    order: [STORY_WORKSPACE_ID],
    byId: { [STORY_WORKSPACE_ID]: { id: STORY_WORKSPACE_ID, root: '/workspace/doompi', available: true } },
    selectedId: STORY_WORKSPACE_ID,
    hydrated: true,
  }));
  sessionStoreFor(STORY_SESSION_ID).setState(() => ({ ...initialSessionState, ...patch }));
}

/** A memory router supplies navigation context without starting the application runtime. */
export function StoryFrame({
  children,
  path = '/',
  className = 'mx-auto min-h-screen max-w-3xl bg-doom-bg p-6',
}: {
  children: ReactNode;
  path?: string;
  className?: string;
}) {
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const component = () => (
      <TooltipProvider>
        <div className={className}>{children}</div>
      </TooltipProvider>
    );
    const routes = ['/', '/session/$sessionId', '/session/$sessionId/$tabId', '/settings', '/settings/$section'].map(
      (routePath) =>
        createRoute({ getParentRoute: () => root, path: routePath, component, validateSearch: (search) => search }),
    );
    return createRouter({
      routeTree: root.addChildren(routes),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
  });
  return <RouterProvider router={router} />;
}
