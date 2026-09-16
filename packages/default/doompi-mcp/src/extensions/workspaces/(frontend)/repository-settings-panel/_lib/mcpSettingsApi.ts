import { api } from '../../../../../../generated/client';
import {
  MCP_FLOW_ID_PARAM,
  MCP_REPOSITORY_ID_QUERY,
  type McpAuthorizationFlow,
  type McpRepositoryCatalog,
} from '../../../../../types/webMcp';

/**
 * The panel's half of this package's repository API.
 *
 * The generated client owns every URL, addressed at the workspace scope the
 * repository names, so nothing here spells a mount. The workspace prefix, the
 * plugins segment and the base path used to be concatenated at the top of this
 * file, the only copy of that shape outside the host, and it agreed with the
 * route by inspection alone.
 *
 * The transport stays injected, which is the one way this package differs from
 * its siblings. Every write here is step-up gated: the panel passes the
 * elevated request for discovery, authorization and cancellation and the plain
 * one for reads, and that choice belongs to the caller. So the client is asked
 * for the URL and the method, and the caller's own request issues them.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

export type McpRequest = (input: string, init?: RequestInit) => Promise<Response>;
export type McpApiResult<T> = { value: T } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resultOf<T>(response: Response, fallback: string): Promise<McpApiResult<T>> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    return { error: isRecord(body) && typeof body.error === 'string' ? body.error : fallback };
  }
  return { value: body as T };
}

export async function readMcpCatalog(
  request: McpRequest,
  repositoryId: string,
): Promise<McpApiResult<McpRepositoryCatalog>> {
  const route = api.workspace(repositoryId).catalog;
  const response = await request(route.url({ query: { [MCP_REPOSITORY_ID_QUERY]: repositoryId } }));
  return await resultOf(response, 'The synced MCP catalog could not be read.');
}

export async function discoverMcpCatalog(
  requestWithStepUp: McpRequest,
  repositoryId: string,
): Promise<McpApiResult<McpRepositoryCatalog>> {
  const route = api.workspace(repositoryId).discover;
  const response = await requestWithStepUp(route.url(), {
    method: route.spec.method,
    headers: JSON_HEADERS,
    body: JSON.stringify({ repositoryId }),
  });
  return await resultOf(response, 'MCP discovery could not be completed.');
}

export async function startMcpAuthorization(
  requestWithStepUp: McpRequest,
  repositoryId: string,
  serverName: string,
): Promise<McpApiResult<McpAuthorizationFlow>> {
  const route = api.workspace(repositoryId).authorize;
  const response = await requestWithStepUp(route.url(), {
    method: route.spec.method,
    headers: JSON_HEADERS,
    body: JSON.stringify({ repositoryId, serverName }),
  });
  return await resultOf(response, 'MCP authorization could not be started.');
}

export async function readMcpAuthorization(
  request: McpRequest,
  repositoryId: string,
  flowId: string,
): Promise<McpApiResult<McpAuthorizationFlow>> {
  const route = api.workspace(repositoryId).readAuthorization;
  const response = await request(
    route.url({ params: { [MCP_FLOW_ID_PARAM]: flowId }, query: { [MCP_REPOSITORY_ID_QUERY]: repositoryId } }),
  );
  return await resultOf(response, 'The authorization state could not be read.');
}

export async function cancelMcpAuthorization(
  requestWithStepUp: McpRequest,
  repositoryId: string,
  flowId: string,
): Promise<McpApiResult<McpAuthorizationFlow>> {
  const route = api.workspace(repositoryId).cancelAuthorization;
  const response = await requestWithStepUp(
    route.url({ params: { [MCP_FLOW_ID_PARAM]: flowId }, query: { [MCP_REPOSITORY_ID_QUERY]: repositoryId } }),
    { method: route.spec.method },
  );
  return await resultOf(response, 'The authorization flow could not be cancelled.');
}
