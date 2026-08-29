import type { DoomApi, DoomApiContext } from '@agimon-ai/doompi-extension-contracts/package-api';
import { MCP_AUTHORIZATION_API_PATH, MCP_DISCOVERY_API_PATH, MCP_REPOSITORY_API_PATH } from '../../types/webMcp.ts';
import { McpSettingsManager } from '../node/mcpSettingsManager.ts';

const JSON_HEADERS = { 'content-type': 'application/json' };
const REPOSITORY_ID = /^repo-[A-Za-z0-9_-]{24}$/u;
const FLOW_ID = /^[a-f0-9-]{36}$/u;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_SERVER_NAME = 160;
const manager = new McpSettingsManager();

type JsonRecord = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function bodyOf(request: Request): Promise<JsonRecord | undefined> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function repositoryIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && REPOSITORY_ID.test(value) ? value : undefined;
}

function serverNameOf(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SERVER_NAME &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f)
    ? value
    : undefined;
}

function resolveRepository(context: DoomApiContext, repositoryId: string): string | undefined {
  return context.resolveRepository?.(repositoryId);
}

function errorStatus(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('already active')) return { status: 409, message };
  if (message.startsWith('Sync this repository')) return { status: 409, message };
  if (message.includes('not enabled')) return { status: 404, message };
  return { status: 500, message: 'MCP management could not complete that request.' };
}

async function handleCatalog(request: Request, context: DoomApiContext): Promise<Response> {
  const repositoryId = repositoryIdOf(new URL(request.url).searchParams.get('repositoryId'));
  if (!repositoryId) return json({ error: 'A valid repositoryId is required.' }, 400);
  const repositoryRoot = resolveRepository(context, repositoryId);
  if (!repositoryRoot) return json({ error: 'That repository is not available to this hub.' }, 404);
  try {
    return json(await manager.readCatalog(repositoryId, repositoryRoot, context.readRepositorySync?.(repositoryId)));
  } catch {
    return json({ error: 'The synced MCP catalog could not be read.' }, 500);
  }
}

async function handleDiscovery(request: Request, context: DoomApiContext): Promise<Response> {
  const body = await bodyOf(request);
  const repositoryId = repositoryIdOf(body?.repositoryId);
  if (!repositoryId) return json({ error: 'A valid repositoryId is required.' }, 400);
  const repositoryRoot = resolveRepository(context, repositoryId);
  if (!repositoryRoot) return json({ error: 'That repository is not available to this hub.' }, 404);
  try {
    return json(await manager.discover(repositoryId, repositoryRoot, context.readRepositorySync?.(repositoryId)));
  } catch (error) {
    const failure = errorStatus(error);
    return json({ error: failure.message }, failure.status);
  }
}

async function handleAuthorize(request: Request, context: DoomApiContext): Promise<Response> {
  const body = await bodyOf(request);
  const repositoryId = repositoryIdOf(body?.repositoryId);
  const serverName = serverNameOf(body?.serverName);
  if (!repositoryId || !serverName) return json({ error: 'A valid repositoryId and serverName are required.' }, 400);
  const repositoryRoot = resolveRepository(context, repositoryId);
  if (!repositoryRoot) return json({ error: 'That repository is not available to this hub.' }, 404);
  try {
    return json(
      await manager.authorize(repositoryId, repositoryRoot, context.readRepositorySync?.(repositoryId), serverName),
      202,
    );
  } catch (error) {
    const failure = errorStatus(error);
    return json({ error: failure.message }, failure.status);
  }
}

async function handleAuthorizationFlow(request: Request, context: DoomApiContext, path: string): Promise<Response> {
  const flowId = path.slice(`${MCP_AUTHORIZATION_API_PATH}/`.length);
  const repositoryId = repositoryIdOf(new URL(request.url).searchParams.get('repositoryId'));
  if (!repositoryId || !FLOW_ID.test(flowId))
    return json({ error: 'A valid repositoryId and flow id are required.' }, 400);
  if (!resolveRepository(context, repositoryId)) {
    return json({ error: 'That repository is not available to this hub.' }, 404);
  }
  if (request.method === 'DELETE') {
    const flow = await manager.cancelAuthorization(flowId, repositoryId);
    return flow ? json(flow) : json({ error: 'That authorization flow was not found.' }, 404);
  }
  const flow = manager.getAuthorization(flowId, repositoryId);
  return flow ? json(flow) : json({ error: 'That authorization flow was not found.' }, 404);
}

export const mcpHubApi: DoomApi = {
  basePath: 'mcp',
  start(context) {
    return {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === MCP_REPOSITORY_API_PATH) {
          return await handleCatalog(request, context);
        }
        if (request.method === 'POST' && path === MCP_DISCOVERY_API_PATH) {
          return await handleDiscovery(request, context);
        }
        if (request.method === 'POST' && path === MCP_AUTHORIZATION_API_PATH) {
          return await handleAuthorize(request, context);
        }
        if (
          (request.method === 'GET' || request.method === 'DELETE') &&
          path.startsWith(`${MCP_AUTHORIZATION_API_PATH}/`)
        ) {
          return await handleAuthorizationFlow(request, context, path);
        }
        return json({ error: 'Not found.' }, 404);
      },
      close() {
        void manager.dispose();
      },
    };
  },
};
