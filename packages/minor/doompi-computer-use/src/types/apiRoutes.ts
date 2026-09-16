import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import {
  COMPUTER_USE_ROUTES,
  type ComputerUseActivationRequest,
  type ComputerUseBrokerRequest,
  type ComputerUseSessionView,
} from './computerUseApi';

/**
 * This package's routes, as data.
 *
 * No scope and no base path: the build reads both off
 * `src/extensions/workspaces/sessions/(backend)/api/computer-use/`, so the
 * mount is stated once, by the folder that creates it.
 *
 * The paths come from `COMPUTER_USE_ROUTES` rather than being written out
 * again. That table already addressed the broker from the hub channel and from
 * the broker's own dispatcher, and a second copy here is exactly the
 * disagreement this file exists to prevent. The dispatcher now reads this
 * table, so the page, the broker and the hub all resolve one set of strings.
 *
 * Only `activate` is reachable from a browser. The `/agent/` and `/hub/` routes
 * each demand a host-issued bearer token and answer 404 without one; they are
 * declared here because they are this API's surface, not because a page calls
 * them.
 */
export default defineApiRoutes({
  activate: {
    method: 'POST',
    path: COMPUTER_USE_ROUTES.activate,
    response: apiResponse<ComputerUseSessionView>(),
  },
  agentState: {
    method: 'GET',
    path: COMPUTER_USE_ROUTES.agentState,
    response: apiResponse<ComputerUseSessionView>(),
  },
  /** Answers whatever the admitted Desktop provider returned, which is runtime-defined JSON. */
  agentObserve: {
    method: 'POST',
    path: COMPUTER_USE_ROUTES.agentObserve,
    response: apiResponse<unknown>(),
  },
  agentAction: {
    method: 'POST',
    path: COMPUTER_USE_ROUTES.agentAction,
    response: apiResponse<unknown>(),
  },
  agentStop: {
    method: 'POST',
    path: COMPUTER_USE_ROUTES.agentStop,
    response: apiResponse<ComputerUseSessionView>(),
  },
  hubState: {
    method: 'GET',
    path: COMPUTER_USE_ROUTES.hubState,
    response: apiResponse<ComputerUseSessionView>(),
  },
  /** Null until a reader has confirmed one; reading it moves the session to `activating`. */
  hubActivation: {
    method: 'GET',
    path: COMPUTER_USE_ROUTES.hubActivation,
    response: apiResponse<ComputerUseActivationRequest | null>(),
  },
  hubAuthorization: {
    method: 'GET',
    path: COMPUTER_USE_ROUTES.hubAuthorization,
    response: apiResponse<{ readonly grantId: string; readonly expiresAt?: number } | null>(),
  },
  hubNext: {
    method: 'GET',
    path: COMPUTER_USE_ROUTES.hubNext,
    response: apiResponse<ComputerUseBrokerRequest | null>(),
  },
  hubComplete: {
    method: 'POST',
    path: COMPUTER_USE_ROUTES.hubComplete,
    response: apiResponse<ComputerUseSessionView>(),
  },
  hubStop: {
    method: 'POST',
    path: COMPUTER_USE_ROUTES.hubStop,
    response: apiResponse<ComputerUseSessionView>(),
  },
});
