import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import { NAME_PARAM } from '../constants/promptsApi';
import { PROMPTS_PATH } from '../constants/webPrompts';
import type { SavedPromptListResponse, SavedPromptWriteResponse } from './webPrompts';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/(backend)/api/prompts/`, so the mount is stated once, by the
 * folder that creates it. This package stated it three times before: a
 * constant, and the literal `prompts` twice more inside a URL builder that also
 * decided, on its own, whether a call was global or session scoped.
 *
 * The Hono app registers these paths and the browser addresses them, so a path
 * cannot move on one side alone.
 *
 * `:name` is Hono's own parameter syntax, because the app registers `path`
 * verbatim. The generated client has no way to fill a path parameter, so the
 * two routes carrying one are addressed through `url()` with that one segment
 * substituted; see the page's `_lib/promptsApi.ts`.
 */
export default defineApiRoutes({
  list: {
    method: 'GET',
    path: PROMPTS_PATH,
    response: apiResponse<SavedPromptListResponse>(),
  },
  save: {
    method: 'PUT',
    path: `${PROMPTS_PATH}/:${NAME_PARAM}`,
    response: apiResponse<SavedPromptWriteResponse>(),
  },
  /** The same path as `save`; the method is the whole of the difference. */
  remove: {
    method: 'DELETE',
    path: `${PROMPTS_PATH}/:${NAME_PARAM}`,
  },
});
