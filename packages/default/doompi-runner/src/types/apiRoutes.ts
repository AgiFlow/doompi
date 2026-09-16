import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import { RUN_ID_PARAM } from '../constants/webRunnerLog';
import { RUNNER_LOG_PARAMS, type RunnerLogResponse } from './webRunnerLog';

/**
 * This package's routes, as data.
 *
 * No scope and no base path: the build reads both off
 * `src/extensions/workspaces/sessions/(backend)/api/runner/`, so the mount is
 * stated once, by the folder that creates it. This package stated it four times
 * before, once per URL builder, each of them re-spelling `/plugins/` and the
 * session prefix by hand.
 *
 * The Hono app registers these paths verbatim and the browser addresses them,
 * so a path cannot move on one side alone. `:runId` is Hono's own parameter
 * syntax for that reason; a caller supplies the value as `params`, and the
 * client encodes the segment.
 */
export default defineApiRoutes({
  log: {
    method: 'GET',
    path: `/runners/:${RUN_ID_PARAM}/log`,
    query: [
      RUNNER_LOG_PARAMS.lines,
      RUNNER_LOG_PARAMS.grep,
      RUNNER_LOG_PARAMS.ignoreCase,
      RUNNER_LOG_PARAMS.contextLines,
    ],
    response: apiResponse<RunnerLogResponse>(),
  },
  /**
   * The live tail of that same log.
   *
   * `stream: true`, so the client exposes a URL and no call method: the
   * consumer is the browser's own `EventSource`, and a relayed call would
   * buffer a stream that never ends.
   */
  logStream: {
    method: 'GET',
    path: `/runners/:${RUN_ID_PARAM}/log/stream`,
    query: [RUNNER_LOG_PARAMS.from],
    stream: true,
  },
  /** The unscrubbed pane bytes, for a terminal emulator rather than a reader. */
  screenStream: {
    method: 'GET',
    path: `/runners/:${RUN_ID_PARAM}/screen/stream`,
    query: [RUNNER_LOG_PARAMS.from],
    stream: true,
  },
  input: {
    method: 'POST',
    path: `/runners/:${RUN_ID_PARAM}/screen/input`,
  },
});
