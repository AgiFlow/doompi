import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import type {
  WorkflowArtifactContentResponse,
  WorkflowArtifactsResponse,
  WorkflowControlResponse,
  WorkflowDeleteResponse,
  WorkflowLaunchResponse,
  WorkflowSteerResponse,
  WorkflowStopResponse,
} from './webWorkflowTerminal';

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/(backend)/api/workflow/`, so the mount is stated once, by the
 * folder that creates it. The same API answers at all three scopes, because a
 * global contribution cascades into workspace and session; the folder under
 * `workspaces/sessions/` only re-mounts it for a session's own server.
 *
 * This is the one file the routes, the Hono app and the browser all read, so a
 * path cannot move on one side alone. The page used to build the hub's own
 * absolute URL and then rewrite its plugin prefix with String.replace to reach
 * a session, which is exactly the kind of copy that can move by one character
 * without anything noticing.
 *
 * `:workspace` and `:runKey` are Hono's own parameter syntax, because the app
 * registers `path` verbatim.
 */

/** One run, which every route below addresses. */
const RUN = '/runs/:workspace/:runKey';

/**
 * The artifact route's parameter, as Hono spells a multi-segment match.
 *
 * An artifact is named by its path inside the run directory, so `reports/a.md`
 * is one parameter across two segments. The client's `params` substitution
 * fills a single segment and percent-encodes the slash with it, so the page
 * substitutes this one itself; see the page's `_lib/terminalApi.ts`.
 */
export const ARTIFACT_NAME_PARAM = ':name{.+}';

/**
 * The step whose pane a terminal route reads: a step ref's id. Absent, the
 * route follows the run's current step, which is one of a parallel group's.
 */
export const STEP_TARGET_PARAM = 'step';

/** Query parameters the artifact route reads, spelled once for both halves. */
export const ARTIFACT_RAW_PARAM = 'raw';
export const ARTIFACT_DOWNLOAD_PARAM = 'download';

export default defineApiRoutes({
  /**
   * The terminal, as server-sent events.
   *
   * `stream: true` gets a URL and no call method: the consumer is the browser's
   * own `EventSource`, and a relayed call would buffer a stream that never ends.
   */
  screen: {
    method: 'GET',
    path: `${RUN}/screen/stream`,
    query: [STEP_TARGET_PARAM],
    stream: true,
  },
  control: {
    method: 'POST',
    path: `${RUN}/control`,
    response: apiResponse<WorkflowControlResponse>(),
  },
  keys: {
    method: 'POST',
    path: `${RUN}/keys`,
  },
  resize: {
    method: 'POST',
    path: `${RUN}/resize`,
    response: apiResponse<{ resized: boolean }>(),
  },
  remove: {
    method: 'DELETE',
    path: RUN,
    response: apiResponse<WorkflowDeleteResponse>(),
  },
  stop: {
    method: 'POST',
    path: `${RUN}/stop`,
    response: apiResponse<WorkflowStopResponse>(),
  },
  /** Guidance for the agent session the running step is in, like steering a Team sub-agent. */
  steer: {
    method: 'POST',
    path: `${RUN}/steer`,
    response: apiResponse<WorkflowSteerResponse>(),
  },
  /**
   * Launch a workflow into the mounting session's own runtime, which then owns
   * the run. A dispatcher session reaches its root's session mount through this.
   */
  launch: {
    method: 'POST',
    path: '/launch',
    response: apiResponse<WorkflowLaunchResponse>(),
  },
  artifacts: {
    method: 'GET',
    path: `${RUN}/artifacts`,
    response: apiResponse<WorkflowArtifactsResponse>(),
  },
  /** One artifact: its metadata and text, or its raw bytes under `raw=1`. */
  artifact: {
    method: 'GET',
    path: `${RUN}/artifacts/${ARTIFACT_NAME_PARAM}`,
    query: [ARTIFACT_RAW_PARAM, ARTIFACT_DOWNLOAD_PARAM],
    response: apiResponse<WorkflowArtifactContentResponse>(),
  },
});
