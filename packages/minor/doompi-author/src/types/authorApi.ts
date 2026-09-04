import type { AuthorModeActivation } from './author.ts';

export const API_BASE_PATH = 'author';
export const SESSION_QUERY_PARAM = 'session';
export const AUTHOR_STATE_PATH = '/state';
export const AUTHOR_BRIDGE_ROUTES = {
  register: '/bridge/register',
  catalog: '/bridge/catalog',
  next: '/bridge/next',
  result: '/bridge/result',
  cancelled: '/bridge/cancelled',
  disconnect: '/bridge/disconnect',
  describe: '/bridge/describe',
  invoke: '/bridge/invoke',
} as const;

export function authorStateUrl(sessionId: string): string {
  const search = new URLSearchParams({ [SESSION_QUERY_PARAM]: sessionId });
  return `/api/plugin/${API_BASE_PATH}${AUTHOR_STATE_PATH}?${search.toString()}`;
}

export interface AuthorSessionView {
  sessionId: string | null;
  activation: AuthorModeActivation;
  capabilityCount: number;
}
