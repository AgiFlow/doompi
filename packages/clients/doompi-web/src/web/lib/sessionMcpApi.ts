import type {
  CreatedSessionMcpClient,
  CreateSessionMcpClientInput,
  SessionMcpClient,
  SessionMcpConfig,
  SessionMcpSkill,
  SessionMcpTool,
} from '../../types/sessionMcp';
import { sealedHttpSession } from './sealedSession';

export type SessionMcpResult<T> = T | { error: string };

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Doompi-Mcp-Csrf': '1' };
const UNREACHABLE = 'The cockpit hub is unreachable.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTool(value: unknown): value is SessionMcpTool {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.label === 'string' &&
    typeof value.description === 'string'
  );
}

function isSkill(value: unknown): value is SessionMcpSkill {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.uri === 'string'
  );
}

function isConfig(value: unknown): value is SessionMcpConfig {
  return (
    isRecord(value) &&
    typeof value.audience === 'string' &&
    typeof value.authorizationEndpoint === 'string' &&
    typeof value.tokenEndpoint === 'string' &&
    Array.isArray(value.tools) &&
    value.tools.every(isTool) &&
    Array.isArray(value.skills) &&
    value.skills.every(isSkill)
  );
}

function isClient(value: unknown): value is SessionMcpClient {
  return (
    isRecord(value) &&
    typeof value.clientId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.redirectUri === 'string' &&
    value.tokenEndpointAuthMethod === 'client_secret_post' &&
    typeof value.createdAt === 'number' &&
    (value.scope === undefined || value.scope === 'restricted' || value.scope === 'session') &&
    isStringArray(value.tools) &&
    isStringArray(value.skills) &&
    typeof value.audience === 'string'
  );
}

function clientMetadata(value: unknown): SessionMcpClient | undefined {
  if (!isClient(value)) return undefined;
  return {
    clientId: value.clientId,
    name: value.name,
    redirectUri: value.redirectUri,
    tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
    createdAt: value.createdAt,
    scope: value.scope === 'session' ? 'session' : 'restricted',
    tools: value.tools,
    skills: value.skills,
    audience: value.audience,
  };
}

function isCreatedClient(value: unknown): value is CreatedSessionMcpClient {
  return isClient(value) && isRecord(value) && typeof value.clientSecret === 'string';
}

function route(workspaceId: string, sessionId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/mcp`;
}

async function request<T>(
  input: string,
  init: RequestInit | undefined,
  pick: (body: Record<string, unknown>) => T | undefined,
): Promise<SessionMcpResult<T>> {
  let response: Response;
  try {
    response = await sealedHttpSession.fetch(input, init);
  } catch {
    return { error: UNREACHABLE };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok && isRecord(body)) {
    const picked = pick(body);
    if (picked !== undefined) return picked;
  }
  return {
    error:
      isRecord(body) && typeof body.error === 'string' ? body.error : `The hub answered ${String(response.status)}.`,
  };
}

export async function readSessionMcpConfig(
  workspaceId: string,
  sessionId: string,
): Promise<SessionMcpResult<{ config: SessionMcpConfig }>> {
  return await request(`${route(workspaceId, sessionId)}/config`, { cache: 'no-store' }, (body) =>
    isConfig(body) ? { config: body } : undefined,
  );
}

export async function listSessionMcpClients(
  workspaceId: string,
  sessionId: string,
): Promise<SessionMcpResult<{ clients: SessionMcpClient[] }>> {
  return await request(`${route(workspaceId, sessionId)}/clients`, { cache: 'no-store' }, (body) => {
    if (!Array.isArray(body.clients)) return undefined;
    const clients = body.clients.map(clientMetadata);
    return clients.every((client) => client !== undefined) ? { clients } : undefined;
  });
}

export async function createSessionMcpClient(
  workspaceId: string,
  sessionId: string,
  input: CreateSessionMcpClientInput,
): Promise<SessionMcpResult<{ client: CreatedSessionMcpClient }>> {
  return await request(
    `${route(workspaceId, sessionId)}/clients`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(input) },
    (body) => (isCreatedClient(body.client) ? { client: body.client } : undefined),
  );
}

export async function revokeSessionMcpClient(
  workspaceId: string,
  sessionId: string,
  clientId: string,
): Promise<SessionMcpResult<{ ok: true }>> {
  return await request(
    `${route(workspaceId, sessionId)}/clients/${encodeURIComponent(clientId)}`,
    { method: 'DELETE', headers: { 'X-Doompi-Mcp-Csrf': '1' } },
    (body) => (body.ok === true ? { ok: true } : undefined),
  );
}
