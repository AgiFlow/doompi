/**
 * The vocabulary this package's HTTP API and its cockpit plugin share.
 *
 * DESIGN PATTERNS:
 * - Wire JSON only, no node types, so the browser bundle can carry this module.
 * - Paths live in src/types/apiRoutes and URLs are built by the generated
 *   client, so a page never assembles one and the two halves cannot drift.
 *   This file used to build them, spelling the mount twice more than the
 *   constant that already held it and choosing the scope from a nullable
 *   session id.
 * - Saved prompts are machine-wide, so no route names a session; a session id
 *   only selects which copy of the hub answers.
 *
 * AVOID:
 * - Importing anything from src/services or src/adapters here.
 */

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
