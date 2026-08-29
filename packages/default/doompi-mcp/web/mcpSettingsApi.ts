import type { McpAuthorizationFlow, McpRepositoryCatalog } from '../src/types/webMcp.ts';
import { MCP_AUTHORIZATION_API_PATH, MCP_DISCOVERY_API_PATH, MCP_REPOSITORY_API_PATH } from '../src/types/webMcp.ts';

const API_ROOT = '/api/plugin/mcp';
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
  const response = await request(
    `${API_ROOT}${MCP_REPOSITORY_API_PATH}?repositoryId=${encodeURIComponent(repositoryId)}`,
  );
  return await resultOf(response, 'The synced MCP catalog could not be read.');
}

export async function discoverMcpCatalog(
  requestWithStepUp: McpRequest,
  repositoryId: string,
): Promise<McpApiResult<McpRepositoryCatalog>> {
  const response = await requestWithStepUp(`${API_ROOT}${MCP_DISCOVERY_API_PATH}`, {
    method: 'POST',
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
  const response = await requestWithStepUp(`${API_ROOT}${MCP_AUTHORIZATION_API_PATH}`, {
    method: 'POST',
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
  const response = await request(
    `${API_ROOT}${MCP_AUTHORIZATION_API_PATH}/${encodeURIComponent(flowId)}?repositoryId=${encodeURIComponent(repositoryId)}`,
  );
  return await resultOf(response, 'The authorization state could not be read.');
}

export async function cancelMcpAuthorization(
  requestWithStepUp: McpRequest,
  repositoryId: string,
  flowId: string,
): Promise<McpApiResult<McpAuthorizationFlow>> {
  const response = await requestWithStepUp(
    `${API_ROOT}${MCP_AUTHORIZATION_API_PATH}/${encodeURIComponent(flowId)}?repositoryId=${encodeURIComponent(repositoryId)}`,
    { method: 'DELETE' },
  );
  return await resultOf(response, 'The authorization flow could not be cancelled.');
}
