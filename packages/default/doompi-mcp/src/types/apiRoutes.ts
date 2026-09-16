import { apiResponse, defineApiRoutes } from '@agimon-ai/doompi-core/web';

import {
  MCP_AUTHORIZATION_API_PATH,
  MCP_DISCOVERY_API_PATH,
  MCP_FLOW_ID_PARAM,
  MCP_REPOSITORY_API_PATH,
  MCP_REPOSITORY_ID_QUERY,
  type McpAuthorizationFlow,
  type McpRepositoryCatalog,
} from './webMcp';

/** One authorization flow, addressed by id below the flow collection. */
const AUTHORIZATION_FLOW_PATH = `${MCP_AUTHORIZATION_API_PATH}/:${MCP_FLOW_ID_PARAM}`;

/**
 * This package's routes, as data.
 *
 * No scope and no base path. The build reads both off
 * `src/extensions/(backend)/api/mcp/`, so the mount is stated once, by the
 * folder that creates it. The sub-paths come from `webMcp`, which already owned
 * them, so this table names where a route sits and nothing else.
 *
 * This is the one file the hub handler and the settings panel both read, so a
 * path cannot move on one side alone. The handler matches on these strings
 * rather than parsing its own copies of them.
 *
 * `:flowId` is the client's parameter syntax; the handler reads the segment off
 * the same path, so the two cannot disagree about where the id sits.
 */
export default defineApiRoutes({
  catalog: {
    method: 'GET',
    path: MCP_REPOSITORY_API_PATH,
    query: [MCP_REPOSITORY_ID_QUERY],
    response: apiResponse<McpRepositoryCatalog>(),
  },
  discover: {
    method: 'POST',
    path: MCP_DISCOVERY_API_PATH,
    response: apiResponse<McpRepositoryCatalog>(),
  },
  authorize: {
    method: 'POST',
    path: MCP_AUTHORIZATION_API_PATH,
    response: apiResponse<McpAuthorizationFlow>(),
  },
  readAuthorization: {
    method: 'GET',
    path: AUTHORIZATION_FLOW_PATH,
    query: [MCP_REPOSITORY_ID_QUERY],
    response: apiResponse<McpAuthorizationFlow>(),
  },
  /** The same path as `readAuthorization`; the method is the whole of the difference. */
  cancelAuthorization: {
    method: 'DELETE',
    path: AUTHORIZATION_FLOW_PATH,
    query: [MCP_REPOSITORY_ID_QUERY],
    response: apiResponse<McpAuthorizationFlow>(),
  },
});
