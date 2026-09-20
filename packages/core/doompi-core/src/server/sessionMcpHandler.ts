import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { SessionMcpAccessGrant, SessionMcpAuthorizationService } from '../services/sessionMcpAuthorization';
import type { SessionToolSurface } from '../types/server/sessionToolSurface';

export interface SessionMcpTarget {
  readonly generation: number;
  readonly toolSurface: SessionToolSurface;
}

export interface SessionMcpHttpHandlerOptions {
  /** Exact HTTPS resource indicator minted into access grants. */
  readonly audience: string;
  readonly authorization: Pick<SessionMcpAuthorizationService, 'authenticateAccessToken'>;
  readonly resourceMetadataUrl?: string;
  readonly resolveSession: (sessionId: string) => SessionMcpTarget | undefined | Promise<SessionMcpTarget | undefined>;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export type SessionMcpHttpHandler = (request: Request) => Promise<Response>;

function jsonError(status: number, message: string, authenticate = false, resourceMetadataUrl?: string): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32_000, message }, id: null },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        ...(authenticate
          ? {
              'www-authenticate':
                resourceMetadataUrl === undefined ? 'Bearer' : `Bearer resource_metadata="${resourceMetadataUrl}"`,
            }
          : {}),
      },
    },
  );
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  const match = authorization === null ? undefined : /^Bearer ([A-Za-z0-9_-]+)$/iu.exec(authorization);
  return match?.[1];
}

function currentUrl(request: Request): string | undefined {
  try {
    const url = new URL(request.url);
    return url.search === '' && url.hash === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function grantedSurface(grant: SessionMcpAccessGrant, surface: SessionToolSurface) {
  const snapshot = surface.readSurface();
  const toolNames = new Set(grant.tools);
  const skillNames = new Set(grant.skills);
  return {
    snapshot,
    tools: grant.scope === 'session' ? snapshot.tools : snapshot.tools.filter((tool) => toolNames.has(tool.name)),
    skills: grant.scope === 'session' ? snapshot.skills : snapshot.skills.filter((skill) => skillNames.has(skill.name)),
  };
}

/** Creates a Bearer-only, stateless Streamable HTTP MCP request handler for session capabilities. */
export function createSessionMcpHttpHandler(options: SessionMcpHttpHandlerOptions): SessionMcpHttpHandler {
  const audience = new URL(options.audience);
  if (
    audience.protocol !== 'https:' ||
    audience.username !== '' ||
    audience.password !== '' ||
    audience.search !== '' ||
    audience.hash !== ''
  ) {
    throw new Error('Session MCP audience must be an absolute HTTPS URL without credentials, a query, or a fragment.');
  }
  const exactAudience = audience.href;
  const operations = new Map<string, AbortController>();
  const operationKey = (grant: SessionMcpAccessGrant, requestId: string | number): string =>
    JSON.stringify([grant.clientId, grant.sessionId, grant.sessionGeneration, requestId]);

  return async (request) => {
    if (currentUrl(request) !== exactAudience) return jsonError(404, 'MCP resource not found.');
    const token = bearerToken(request);
    if (token === undefined)
      return jsonError(401, 'A Bearer access token is required.', true, options.resourceMetadataUrl);
    const grant = options.authorization.authenticateAccessToken(token, exactAudience);
    if (grant === undefined)
      return jsonError(401, 'The Bearer access token is invalid or expired.', true, options.resourceMetadataUrl);
    const authorizeOperation = async (): Promise<{
      grant: SessionMcpAccessGrant;
      target: SessionMcpTarget;
    }> => {
      const activeGrant = options.authorization.authenticateAccessToken(token, exactAudience);
      if (activeGrant === undefined || activeGrant.id !== grant.id) {
        throw new McpError(ErrorCode.InvalidRequest, 'The session grant is no longer active.');
      }
      const target = await options.resolveSession(activeGrant.sessionId);
      const recheckedGrant = options.authorization.authenticateAccessToken(token, exactAudience);
      if (
        recheckedGrant === undefined ||
        recheckedGrant.id !== activeGrant.id ||
        target === undefined ||
        target.generation !== recheckedGrant.sessionGeneration
      ) {
        throw new McpError(ErrorCode.InvalidRequest, 'The session grant is no longer active.');
      }
      return { grant: recheckedGrant, target };
    };
    try {
      await authorizeOperation();
    } catch {
      return jsonError(401, 'The session grant is no longer active.', true, options.resourceMetadataUrl);
    }

    const server = new Server(
      { name: options.serverName ?? 'doompi-session', version: options.serverVersion ?? '1.0.0' },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
      const active = await authorizeOperation();
      if (notification.params.requestId !== undefined) {
        operations.get(operationKey(active.grant, notification.params.requestId))?.abort();
      }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const active = await authorizeOperation();
      const { tools } = grantedSurface(active.grant, active.target.toolSurface);
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.label,
          description: tool.description,
          inputSchema: tool.parameters as Tool['inputSchema'],
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (message, extra): Promise<CallToolResult> => {
      const key = operationKey(grant, extra.requestId);
      if (operations.has(key)) {
        throw new McpError(ErrorCode.InvalidRequest, 'A tool call with this request identity is already active.');
      }
      const controller = new AbortController();
      operations.set(key, controller);
      const signal = AbortSignal.any([request.signal, extra.signal, controller.signal]);
      let skillAccessOpen = true;
      try {
        const active = await authorizeOperation();
        if (active.grant.scope === 'restricted' && !active.grant.tools.includes(message.params.name)) {
          throw new McpError(ErrorCode.InvalidParams, `Tool '${message.params.name}' is not granted.`);
        }
        const { snapshot, tools } = grantedSurface(active.grant, active.target.toolSurface);
        if (!tools.some((tool) => tool.name === message.params.name)) {
          throw new McpError(ErrorCode.InvalidParams, `Tool '${message.params.name}' is not active.`);
        }
        const authorizedSkills = async () => {
          if (!skillAccessOpen)
            throw new McpError(ErrorCode.InvalidRequest, 'Remote skill access is no longer active.');
          signal.throwIfAborted();
          const current = await authorizeOperation();
          if (current.target.toolSurface !== active.target.toolSurface)
            throw new McpError(ErrorCode.InvalidRequest, 'The session tool surface has changed.');
          signal.throwIfAborted();
          return grantedSurface(current.grant, current.target.toolSurface);
        };
        const mcpSkills = {
          async list() {
            const { skills } = await authorizedSkills();
            return skills.map(({ name, description }) => ({ name, description }));
          },
          async read(name: string) {
            const current = await authorizedSkills();
            const skill = current.skills.find((candidate) => candidate.name === name);
            if (skill === undefined) throw new McpError(ErrorCode.InvalidParams, 'Skill is not granted or active.');
            const text = await active.target.toolSurface.readSkill(current.snapshot.revision, skill.uri);
            signal.throwIfAborted();
            const after = await authorizedSkills();
            if (after.snapshot.revision !== current.snapshot.revision)
              throw new McpError(ErrorCode.InvalidRequest, 'The session skill surface has changed.');
            return text;
          },
        };
        const result = await active.target.toolSurface.invokeTool({
          revision: snapshot.revision,
          name: message.params.name,
          arguments: message.params.arguments ?? {},
          signal,
          mcpSkills,
          authorize: async () => {
            const current = await authorizeOperation();
            if (current.target.toolSurface !== active.target.toolSurface) {
              throw new McpError(ErrorCode.InvalidRequest, 'The session tool surface has changed.');
            }
            if (current.grant.scope === 'restricted' && !current.grant.tools.includes(message.params.name)) {
              throw new McpError(ErrorCode.InvalidParams, `Tool '${message.params.name}' is not granted.`);
            }
          },
        });
        await authorizeOperation();
        return { content: result.content, isError: result.isError ?? false };
      } finally {
        skillAccessOpen = false;
        operations.delete(key);
      }
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const active = await authorizeOperation();
      const { skills } = grantedSurface(active.grant, active.target.toolSurface);
      return {
        resources: skills.map((skill) => ({
          uri: skill.uri,
          name: skill.name,
          description: skill.description,
          mimeType: 'text/markdown',
        })),
      };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (message) => {
      const active = await authorizeOperation();
      const { snapshot, skills } = grantedSurface(active.grant, active.target.toolSurface);
      const skill = skills.find((candidate) => candidate.uri === message.params.uri);
      if (skill === undefined) throw new McpError(ErrorCode.InvalidParams, 'Skill resource is not granted or active.');
      const text = await active.target.toolSurface.readSkill(snapshot.revision, skill.uri);
      await authorizeOperation();
      return {
        contents: [
          {
            uri: skill.uri,
            name: skill.name,
            mimeType: 'text/markdown',
            text,
          },
        ],
      };
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, {
        authInfo: {
          token,
          clientId: grant.clientId,
          scopes:
            grant.scope === 'session'
              ? ['session']
              : [...grant.tools.map((name) => `tool:${name}`), ...grant.skills.map((name) => `skill:${name}`)],
          expiresAt: Math.floor(grant.expiresAt / 1000),
          resource: new URL(exactAudience),
        },
      });
    } catch {
      return jsonError(500, 'Internal MCP server error.');
    }
  };
}
