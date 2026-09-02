import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import { findContextItem, readContextDetail } from './contextDetailStore.ts';
import { API_BASE_PATH, ITEM_ROUTE, KIND_QUERY_PARAM, NAME_QUERY_PARAM } from '../types/contextApi.ts';

/**
 * What one row of the composition actually is, on request.
 *
 * The context panel prices every tool and skill the session carries, and the
 * figure is only half an answer: the reader deciding whether a package earns
 * its thousand tokens wants the prose and the schema behind it. Those are too
 * large to push, and they are wanted one row at a time, so they are served
 * here instead and fetched on the click.
 *
 * The agent writes the store; this reads it. The two are separate processes
 * and the inventory only exists inside the agent, which is the same split
 * every other package-owned API in the repository lives with.
 */

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function isItemKind(value: string | null): value is 'tool' | 'skill' {
  return value === 'tool' || value === 'skill';
}

export interface ContextApiOptions {
  /** The session these routes answer for; absent when the host is the hub. */
  sessionId?: string;
  /** Injectable for tests; defaults to the file the agent writes. */
  readDetail?: typeof readContextDetail;
}

export function createContextApi(options: ContextApiOptions = {}): DoomApiHandler {
  const readDetail = options.readDetail ?? readContextDetail;
  return {
    fetch(request: Request): Response {
      const url = new URL(request.url);
      if (url.pathname !== ITEM_ROUTE) return json({ error: 'No such route.' }, 404);
      if (request.method !== 'GET') return json({ error: 'Only GET is served here.' }, 405);
      if (options.sessionId === undefined) return json({ error: 'This host serves no session.' }, 404);

      const itemKind = url.searchParams.get(KIND_QUERY_PARAM);
      const name = url.searchParams.get(NAME_QUERY_PARAM);
      if (!isItemKind(itemKind)) return json({ error: 'Ask for a tool or a skill.' }, 400);
      if (name === null || name === '') return json({ error: 'Name the item to describe.' }, 400);

      const file = readDetail(options.sessionId);
      // A session that has not published yet is the ordinary state for the
      // first half-second of its life, and says so rather than looking broken.
      if (file === undefined) {
        return json({ error: 'This session has not reported its composition yet.' }, 404);
      }
      const item = findContextItem(file, itemKind, name);
      if (item === undefined) return json({ error: `The session carries no ${itemKind} called ${name}.` }, 404);
      return json({ revision: file.revision, item }, 200);
    },
    close: () => {},
  };
}

export const api: DoomApi = {
  basePath: API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    return createContextApi(context.sessionId === undefined ? {} : { sessionId: context.sessionId });
  },
};
