/**
 * The vocabulary this package's HTTP API and its cockpit plugin share.
 *
 * DESIGN PATTERNS:
 * - Wire JSON only, no node types, so the browser bundle can carry this module.
 * - Route paths and URL building live here, so a page never assembles a URL of
 *   its own and the two halves cannot drift.
 * - Saved prompts are machine-wide, so no route names a session.
 *
 * AVOID:
 * - Importing anything from src/services or src/adapters here.
 */

import { DOOM_HUB_API_SESSION_QUERY_PARAM } from '@agimon-ai/doompi-extension-contracts/package-api';

/** Where a host mounts this package's API; the segment after /api/plugin/. */
export const API_BASE_PATH = 'prompts';

/** The collection, relative to the API's own mount. */
export const PROMPTS_PATH = '/prompts';

/** One saved prompt, relative to the API's own mount. */
export function promptPath(name: string): string {
  return `${PROMPTS_PATH}/${encodeURIComponent(name)}`;
}

/** Routes a hub request through the bundle selected for the focused session. */
function hubSessionQuery(sessionId?: string | null): string {
  return sessionId === undefined || sessionId === null
    ? ''
    : `?${DOOM_HUB_API_SESSION_QUERY_PARAM}=${encodeURIComponent(sessionId)}`;
}

/** The absolute URL a page fetches for the collection. */
export function promptsUrl(sessionId?: string | null): string {
  return `/api/plugin/${API_BASE_PATH}${PROMPTS_PATH}${hubSessionQuery(sessionId)}`;
}

/** The absolute URL a page fetches for one saved prompt. */
export function promptUrl(name: string, sessionId?: string | null): string {
  return `/api/plugin/${API_BASE_PATH}${promptPath(name)}${hubSessionQuery(sessionId)}`;
}

/** One saved prompt, as the cockpit shows it. */
export interface SavedPromptView {
  name: string;
  description: string;
  text: string;
}

/** What the collection route answers with. */
export interface SavedPromptListResponse {
  prompts: readonly SavedPromptView[];
}

/** What a write route answers with. */
export interface SavedPromptWriteResponse {
  prompt: SavedPromptView;
  /** True when the write replaced a template that already existed. */
  replaced: boolean;
}

/** What every route answers with when it refuses. */
export interface PromptErrorResponse {
  error: string;
}

export function isPromptErrorResponse(value: unknown): value is PromptErrorResponse {
  return typeof value === 'object' && value !== null && typeof (value as PromptErrorResponse).error === 'string';
}
