import type { AuthorModeActivation } from './author';

/**
 * The wire vocabulary this package's API shares with whatever calls it.
 *
 * Paths live in `./apiRoutes`, which the Hono apps register from and the
 * generated client addresses, so neither half can move alone. What stays here
 * is the mount segment the server registers under and the shape the state
 * route answers with.
 */

/** Where a host mounts this package's API; the segment after /api/plugins/. */
export const API_BASE_PATH = 'author';

/** Query parameter naming the session a document request belongs to. */
export const SESSION_QUERY_PARAM = 'session';

export interface AuthorSessionView {
  sessionId: string | null;
  activation: AuthorModeActivation;
  capabilityCount: number;
}
