import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type { PlanDetailView, PlanSaveView } from './planApi';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/workspaces/sessions/(backend)/api/plans/`, so the mount is
 * stated once, by the folder that creates it. The paths used to be written
 * here as helpers, again in the contract, and again inside every URL the page
 * built, and the copies were free to disagree.
 *
 * This is the one file the routes, the Hono app and the browser all read, so a
 * path cannot move on one side alone.
 *
 * Neither route takes a query or a path parameter: a session has one current
 * plan, so `current` answers it and `save` takes the manual write back.
 */
export default defineApiRoutes({
  current: {
    method: 'GET',
    path: '/current',
    response: apiResponse<PlanDetailView>(),
  },
  save: {
    method: 'PUT',
    path: '/content',
    response: apiResponse<PlanSaveView>(),
  },
});
