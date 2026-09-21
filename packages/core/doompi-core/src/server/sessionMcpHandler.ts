import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

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
import { sessionMcpConversationDigest, SessionMcpConversationError } from '../services/sessionMcpConversations';
import type { SessionToolSurface } from '../types/server/sessionToolSurface';

export interface SessionMcpTarget {
  readonly generation: number;
  readonly sessionId?: string;
  readonly toolSurface: SessionToolSurface;
}

export interface SessionMcpHttpHandlerOptions {
  /** Exact HTTPS resource indicator minted into access grants. */
  readonly audience: string;
  readonly authorization: Pick<SessionMcpAuthorizationService, 'authenticateAccessToken'>;
  readonly onVerified?: (grant: SessionMcpAccessGrant) => void | Promise<void>;
  readonly resourceMetadataUrl?: string;
  readonly resolveSession: (sessionId: string) => SessionMcpTarget | undefined | Promise<SessionMcpTarget | undefined>;
  readonly resolveConversation?: (
    grant: SessionMcpAccessGrant,
    digest: string,
    reserve: boolean,
  ) => SessionMcpTarget | Promise<SessionMcpTarget>;
  /** Only bounded, non-reversible correlation values are reported here. */
  readonly onNotice?: (message: string) => void;
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
  const operations = new Map<string, { controller: AbortController; owner: string; conversation?: string }>();
  const operationOwner = (grant: SessionMcpAccessGrant, requestId: string | number): string =>
    JSON.stringify([grant.clientId, grant.sessionId, grant.sessionGeneration, grant.id, requestId]);

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
      {
        capabilities: { tools: {}, resources: {} },
        instructions:
          'Use only this bound DoomPi session. Call load_context before repository work and after selection changes. ' +
          'Use search_skills and load_skill for relevant guidance. Inspect before editing and follow repository checks. ' +
          'Do not assume local UI access, downloadable host files, or background completion notifications. ' +
          'Read saved command logs instead of relaunching work. Saving a plan does not authorize implementation.',
      },
    );
    server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
      const active = await authorizeOperation();
      if (notification.params.requestId !== undefined) {
        const owner = operationOwner(active.grant, notification.params.requestId);
        const conversation = sessionMcpConversationDigest(notification.params._meta);
        // A late notification without a conversation ID could name a request ID
        // since reused by another chat, even when only one operation remains.
        // HTTP/request cancellation still aborts its own invocation directly.
        if (active.grant.routing === 'conversation' && conversation === undefined) return;
        const candidates = [...operations.values()].filter(
          (operation) =>
            operation.owner === owner && (conversation === undefined || operation.conversation === conversation),
        );
        // A client may omit conversation metadata on notifications. Ambiguity is not authority.
        if (candidates.length === 1) candidates[0]!.controller.abort();
      }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const active = await authorizeOperation();
      await options.onVerified?.(active.grant);
      const { tools } = grantedSurface(active.grant, active.target.toolSurface);
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.label,
          description: tool.description,
          inputSchema: tool.parameters as Tool['inputSchema'],
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (message, extra): Promise<CallToolResult> => {
      const conversation = sessionMcpConversationDigest(message.params._meta);
      const owner = operationOwner(grant, extra.requestId);
      const key = JSON.stringify([owner, conversation]);
      if (operations.has(key))
        throw new McpError(ErrorCode.InvalidRequest, 'A tool call with this request identity is already active.');
      const controller = new AbortController();
      operations.set(key, { controller, owner, conversation });
      const signal = AbortSignal.any([request.signal, extra.signal, controller.signal]);
      let skillAccessOpen = true;
      try {
        const parent = await authorizeOperation();
        const advertised = grantedSurface(parent.grant, parent.target.toolSurface).tools.find(
          (tool) => tool.name === message.params.name,
        );
        if (!advertised)
          throw new McpError(ErrorCode.InvalidParams, `Tool '${message.params.name}' is not granted or active.`);
        // A binding must not outlive an unpersisted registration when tools/call precedes tools/list.
        if (parent.grant.routing === 'conversation') await options.onVerified?.(parent.grant);
        const diagnostic = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
        options.onNotice?.(
          `session MCP correlation client=${diagnostic(grant.clientId)} request=${diagnostic(JSON.stringify(extra.requestId))} conversation=${conversation ?? 'missing'}`,
        );
        const resolveTarget = async (reserve: boolean) => {
          const active = await authorizeOperation();
          if (active.grant.routing !== 'conversation') return active;
          if (!conversation)
            throw new SessionMcpConversationError(
              'CONVERSATION_ID_REQUIRED',
              'This connection requires conversation metadata. Use a dedicated session connection when the client cannot supply it.',
            );
          if (!options.resolveConversation)
            throw new SessionMcpConversationError(
              'CONVERSATION_ROUTING_UNAVAILABLE',
              'Conversation routing is unavailable in this host.',
            );
          signal.throwIfAborted();
          const target = await options.resolveConversation(active.grant, conversation, reserve);
          await authorizeOperation();
          signal.throwIfAborted();
          return { grant: active.grant, target };
        };
        const active = await resolveTarget(true);
        const { snapshot, tools } = grantedSurface(active.grant, active.target.toolSurface);
        const selected = tools.find((tool) => tool.name === message.params.name);
        if (
          !selected ||
          !isDeepStrictEqual(selected.parameters, advertised.parameters) ||
          !isDeepStrictEqual(selected.outputSchema, advertised.outputSchema) ||
          !isDeepStrictEqual(selected.annotations, advertised.annotations)
        ) {
          throw new SessionMcpConversationError(
            'SESSION_TOOL_SURFACE_CHANGED',
            'The target session does not expose the approved tool contract. Refresh the connection or restore a compatible session selection.',
          );
        }
        const recheck = async () => {
          const current = await resolveTarget(false);
          if (
            current.target.toolSurface !== active.target.toolSurface ||
            current.target.generation !== active.target.generation ||
            current.target.sessionId !== active.target.sessionId
          )
            throw new McpError(ErrorCode.InvalidRequest, 'The session tool surface has changed.');
          const currentAdvertised = grantedSurface(current.grant, parent.target.toolSurface).tools.find(
            (tool) => tool.name === message.params.name,
          );
          if (!currentAdvertised || !isDeepStrictEqual(currentAdvertised, advertised))
            throw new McpError(ErrorCode.InvalidRequest, 'The connection tool surface has changed.');
          return current;
        };
        const authorizedSkills = async () => {
          if (!skillAccessOpen)
            throw new McpError(ErrorCode.InvalidRequest, 'Remote skill access is no longer active.');
          signal.throwIfAborted();
          const current = await recheck();
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
            if (!skill) throw new McpError(ErrorCode.InvalidParams, 'Skill is not granted or active.');
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
            await recheck();
          },
        });
        await recheck();
        return {
          content: result.content,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
          isError: result.isError ?? false,
        };
      } catch (error) {
        if (!(error instanceof SessionMcpConversationError)) throw error;
        return {
          content: [{ type: 'text', text: error.message }],
          isError: true,
          structuredContent: {
            code: error.code,
            message: error.message,
            ...(error.bindingId === undefined ? {} : { bindingId: error.bindingId }),
          },
        };
      } finally {
        skillAccessOpen = false;
        operations.delete(key);
      }
    });
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const active = await authorizeOperation();
      if (active.grant.routing === 'conversation') return { resources: [] };
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
      if (active.grant.routing === 'conversation')
        throw new McpError(
          ErrorCode.InvalidParams,
          'Use load_skill with conversation metadata to read target-session guidance.',
        );
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
