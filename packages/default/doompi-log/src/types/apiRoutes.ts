import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import { METRICS_QUERY_PARAMS, type IssuesResponse, type MetricsResponse } from './webMetrics';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/(backend)/api/log/`, so the mount is stated once, by the
 * folder that creates it. They used to be written here, in the contract, and
 * again inside every URL the page built, and the copies were free to disagree.
 *
 * This is the one file the routes, the Hono app and the browser all read, so a
 * path cannot move on one side alone.
 */
export default defineApiRoutes({
  metrics: {
    method: 'GET',
    path: '/metrics',
    query: [METRICS_QUERY_PARAMS.dimension, METRICS_QUERY_PARAMS.period, METRICS_QUERY_PARAMS.focus],
    response: apiResponse<MetricsResponse>(),
  },
  /**
   * Separate from the report because the hub answers it from a subprocess: the
   * running daemon exposes no issues route, so folding it in would make every
   * refresh wait on the slowest transport.
   */
  issues: {
    method: 'GET',
    path: '/issues',
    query: [METRICS_QUERY_PARAMS.focus],
    response: apiResponse<IssuesResponse>(),
  },
});
