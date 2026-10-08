import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/server';

import type { SessionMcpInvocation } from '../schemas/sessionMcpActivity';
import type { SessionMcpAccessGrant, SessionMcpAuthorizationService } from '../services/sessionMcpAuthorization';
import { sessionMcpConversationDigest, SessionMcpConversationError } from '../services/sessionMcpConversations';
import type { SessionToolDescriptor, SessionToolSurface } from '../types/server/sessionToolSurface';

/** Stable transport tools stay available when a conversation changes its MCP composition. */
export const SESSION_MCP_EXTRA_TOOLS: readonly Tool[] = [
  {
    name: 'load_extra_tools',
    title: 'Load extra tools',
    description:
      'List DoomPi tools and skills added to this conversation after your tool list loaded, for example after a mode change. Takes {}. Empty means no change.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['model'] } },
  },
  {
    name: 'use_extra_tools',
    title: 'Use extra tools',
    description:
      'Run a DoomPi tool returned by load_extra_tools that is not in your tool list. Pass { name, arguments }.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, arguments: { type: 'object' } },
      required: ['name'],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ['model'] } },
  },
  {
    name: 'session_capabilities',
    title: 'Session capabilities',
    description:
      'List every DoomPi tool and skill this connection can use now, with input schemas. Call it when a tool seems missing, a call fails, or the session mode changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ['model'] } },
  },
];

export interface SessionMcpBaseline {
  readonly tools: readonly Tool[];
  readonly skills: readonly { name: string; description: string }[];
}

function publicTool(tool: SessionToolDescriptor): Tool {
  return {
    name: tool.name,
    title: tool.label,
    description: tool.description,
    inputSchema: tool.parameters as Tool['inputSchema'],
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    _meta: {
      ...tool._meta,
      ui: { ...tool._meta?.ui, visibility: tool._meta?.ui?.visibility ?? ['model'] },
    },
  };
}

function grantedExtraTools(grant: SessionMcpAccessGrant): readonly Tool[] {
  return grant.scope === 'session'
    ? SESSION_MCP_EXTRA_TOOLS
    : SESSION_MCP_EXTRA_TOOLS.filter((tool) => grant.tools.includes(tool.name));
}

function extraTools(baseline: SessionMcpBaseline, tools: readonly SessionToolDescriptor[]): Tool[] {
  return tools.map(publicTool).filter(
    (tool) =>
      !SESSION_MCP_EXTRA_TOOLS.some((wrapper) => wrapper.name === tool.name) &&
      !isDeepStrictEqual(
        baseline.tools.find((original) => original.name === tool.name),
        tool,
      ),
  );
}

/** Remote agents see `${prefix}_${name}`; grants, baselines, and history keep internal names. */
export function sessionMcpWireName(prefix: string | undefined, name: string): string {
  return prefix === undefined ? name : `${prefix}_${name}`;
}

/** Strips the prefix exactly once. A bare name on a prefixed connection maps to nothing. */
export function sessionMcpInternalName(prefix: string | undefined, wire: string): string | undefined {
  if (prefix === undefined) return wire;
  const head = `${prefix}_`;
  return wire.startsWith(head) && wire.length > head.length ? wire.slice(head.length) : undefined;
}

function wireTool(prefix: string | undefined, tool: Tool): Tool {
  return prefix === undefined ? tool : { ...tool, name: sessionMcpWireName(prefix, tool.name) };
}

/** Kept at or under 512 characters with a 24-character prefix. */
function sessionMcpInstructions(prefix: string | undefined): string {
  return (
    (prefix === undefined ? '' : `Tool names here start with '${prefix}_'. `) +
    'Use only this bound DoomPi session; tools run in its host repository, not locally. ' +
    'Call load_context first and after selection changes. session_capabilities lists current tools; ' +
    'load_extra_tools lists conversation changes, run with use_extra_tools; load_skill loads guidance. ' +
    'Inspect before editing; follow repository checks. Assume no UI, downloads, or notifications. ' +
    'Read saved logs, do not relaunch work. Saving a plan does not authorize implementation.'
  );
}

function toolArguments(
  name: string,
  value: unknown,
  wire: (name: string) => string,
): { name?: string; arguments?: Record<string, unknown> } {
  const invalid = (problem: string): SessionMcpConversationError =>
    new SessionMcpConversationError('TOOL_ARGUMENTS_INVALID', `Invalid arguments for '${wire(name)}': ${problem}`);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('pass a JSON object.');
  const args = value as Record<string, unknown>;
  const keys = Object.keys(args);
  if (name !== 'use_extra_tools') {
    if (keys.length !== 0) throw invalid(`it takes no arguments. Remove: ${keys.join(', ')}. Call it with {}.`);
    return args;
  }
  const unexpected = keys.filter((key) => key !== 'name' && key !== 'arguments');
  if (unexpected.length !== 0)
    throw invalid(`unexpected keys: ${unexpected.join(', ')}. Pass { "name": string, "arguments"?: object }.`);
  if (typeof args.name !== 'string' || args.name.trim() === '')
    throw invalid(`"name" must be a tool name returned by ${wire('load_extra_tools')}.`);
  if (
    args.arguments !== undefined &&
    (typeof args.arguments !== 'object' || args.arguments === null || Array.isArray(args.arguments))
  )
    throw invalid('"arguments" must be an object.');
  return args as { name?: string; arguments?: Record<string, unknown> };
}
export interface SessionMcpTarget {
  readonly generation: number;
  readonly sessionId?: string;
  readonly toolSurface: SessionToolSurface;
  /** Reports whether the session's local agent is blocked from starting turns. */
  readonly agentLocked?: () => boolean;
}

const LOCAL_AGENT_UNLOCKED_NOTICE =
  'The DoomPi user unlocked the local agent in this session, so it may also act here. Check state before you edit.';

export interface SessionMcpHttpHandlerOptions {
  /** Exact HTTPS resource indicator minted into access grants. */
  readonly audience: string;
  readonly authorization: Pick<SessionMcpAuthorizationService, 'authenticateAccessToken' | 'authenticateUrlToken'>;
  readonly onVerified?: (grant: SessionMcpAccessGrant) => void | Promise<void>;
  readonly resourceMetadataUrl?: string;
  /** Signed JWT carried as the final URL path segment instead of an Authorization header. */
  readonly pathToken?: string;
  readonly baselines?: Map<string, SessionMcpBaseline>;
  /** Shared only by signed-URL requests in one live session incarnation. */
  readonly operations?: SessionMcpOperationRegistry;
  readonly resolveSession: (sessionId: string) => SessionMcpTarget | undefined | Promise<SessionMcpTarget | undefined>;
  readonly resolveConversation?: (
    grant: SessionMcpAccessGrant,
    digest: string,
    reserve: boolean,
    signal?: AbortSignal,
  ) => SessionMcpTarget | Promise<SessionMcpTarget>;
  /** Only bounded, non-reversible correlation values are reported here. */
  readonly onNotice?: (message: string) => void;
  /** Host-only call history, separate from MCP notices and the agent transcript. */
  readonly onInvocation?: (invocation: SessionMcpInvocation) => void;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export type SessionMcpOperationRegistry = Map<
  string,
  { controller: AbortController; owner: string; conversation?: string }
>;

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
  if (snapshot.tools.some((tool) => SESSION_MCP_EXTRA_TOOLS.some((wrapper) => wrapper.name === tool.name)))
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      'A session tool conflicts with a reserved remote tool name.',
    );
  const toolNames = new Set(grant.tools);
  const skillNames = new Set(grant.skills);
  const tools = grant.scope === 'session' ? snapshot.tools : snapshot.tools.filter((tool) => toolNames.has(tool.name));
  const resourceUris = new Set(tools.map((tool) => tool._meta?.ui?.resourceUri));
  return {
    snapshot,
    tools,
    skills: grant.scope === 'session' ? snapshot.skills : snapshot.skills.filter((skill) => skillNames.has(skill.name)),
    uiResources: (snapshot.uiResources ?? []).filter((resource) => resourceUris.has(resource.uri)),
  };
}

/** Identity is supplied by the approved tool descriptor, never by upstream result metadata. */
function widgetResult(
  tool: SessionToolDescriptor | undefined,
  result: CallToolResult,
  prefix: string | undefined,
): CallToolResult {
  const widget = tool?._meta?.['doompi/widget'];
  return typeof widget !== 'string'
    ? result
    : {
        ...result,
        // The host compares this with the tool name it called, which is the remote name.
        _meta: { ...result._meta, 'doompi/widget': widget, 'doompi/toolName': sessionMcpWireName(prefix, tool!.name) },
      };
}

/** Creates a stateless Streamable HTTP MCP request handler for session capabilities. */
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
  if (options.pathToken !== undefined && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(options.pathToken)) {
    throw new Error('Session MCP path token must be a compact JWT.');
  }
  const exactResource = options.pathToken === undefined ? exactAudience : `${exactAudience}/${options.pathToken}`;
  const authenticate =
    options.pathToken === undefined
      ? options.authorization.authenticateAccessToken
      : options.authorization.authenticateUrlToken;
  const operations: SessionMcpOperationRegistry = options.operations ?? new Map();
  const baselines = options.baselines ?? new Map<string, SessionMcpBaseline>();
  const operationOwner = (grant: SessionMcpAccessGrant, requestId: string | number): string =>
    JSON.stringify([grant.clientId, grant.sessionId, grant.sessionGeneration, grant.id, requestId]);

  return async (request) => {
    if (currentUrl(request) !== exactResource) return jsonError(404, 'MCP resource not found.');
    const token = options.pathToken ?? bearerToken(request);
    if (token === undefined)
      return jsonError(401, 'A Bearer access token is required.', true, options.resourceMetadataUrl);
    const grant = authenticate(token, exactAudience);
    if (grant === undefined)
      return options.pathToken === undefined
        ? jsonError(401, 'The Bearer access token is invalid or expired.', true, options.resourceMetadataUrl)
        : jsonError(401, 'The signed MCP URL is invalid or revoked.');
    // Bindings are immutable, so the prefix cannot change for the lifetime of this grant.
    const prefix = grant.toolPrefix;
    const wire = (name: string): string => sessionMcpWireName(prefix, name);
    /** Names a wrapper as the next call only when this grant can use it. */
    const nextCall = (tool: string, text: string): string =>
      grantedExtraTools(grant).some((wrapper) => wrapper.name === tool) ? ` Call ${wire(tool)}${text}` : '';
    const surfaceChanged = (): SessionMcpConversationError =>
      new SessionMcpConversationError(
        'SESSION_TOOL_SURFACE_CHANGED',
        `The session tools changed before this call ran.${nextCall('session_capabilities', ', then retry.')}`,
      );
    const authorizeOperation = async (): Promise<{
      grant: SessionMcpAccessGrant;
      target: SessionMcpTarget;
    }> => {
      const activeGrant = authenticate(token, exactAudience);
      if (activeGrant === undefined || activeGrant.id !== grant.id) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'The session grant is no longer active.');
      }
      const target = await options.resolveSession(activeGrant.sessionId);
      const recheckedGrant = authenticate(token, exactAudience);
      if (
        recheckedGrant === undefined ||
        recheckedGrant.id !== activeGrant.id ||
        target === undefined ||
        target.generation !== recheckedGrant.sessionGeneration
      ) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'The session grant is no longer active.');
      }
      return { grant: recheckedGrant, target };
    };
    try {
      await authorizeOperation();
    } catch {
      return options.pathToken === undefined
        ? jsonError(401, 'The session grant is no longer active.', true, options.resourceMetadataUrl)
        : jsonError(401, 'The signed MCP URL is invalid or revoked.');
    }

    const server = new Server(
      { name: options.serverName ?? 'doompi-session', version: options.serverVersion ?? '1.0.0' },
      {
        capabilities: { tools: {}, resources: {} },
        instructions: sessionMcpInstructions(prefix),
      },
    );
    server.setNotificationHandler('notifications/cancelled', async (notification) => {
      const active = await authorizeOperation();
      if (notification.params.requestId === undefined) return;
      const owner = operationOwner(active.grant, notification.params.requestId);
      const conversation = sessionMcpConversationDigest(notification.params._meta);
      // A notification without a conversation identity cannot safely cancel one
      // of several child runtimes that may reuse its request ID.
      if (conversation === undefined) return;
      const candidates = [...operations.values()].filter(
        (operation) => operation.owner === owner && operation.conversation === conversation,
      );
      if (candidates.length === 1) candidates[0]!.controller.abort();
    });
    server.setRequestHandler('tools/list', async () => {
      const active = await authorizeOperation();
      await options.onVerified?.(active.grant);
      const { tools, skills } = grantedSurface(active.grant, active.target.toolSurface);
      const parentTools = tools.map(publicTool);
      const wrappers = grantedExtraTools(active.grant);
      const baseline = structuredClone({
        tools: parentTools,
        skills: skills.map(({ name, description }) => ({ name, description })),
      });
      await authorizeOperation();
      baselines.set(active.grant.clientId, baseline);
      return { tools: [...parentTools, ...wrappers].map((tool) => wireTool(prefix, tool)) };
    });
    server.setRequestHandler('tools/call', async (message, ctx): Promise<CallToolResult> => {
      const conversation = sessionMcpConversationDigest(
        ctx.mcpReq._meta ?? (message.params as { _meta?: unknown })._meta,
      );
      const owner = operationOwner(grant, ctx.mcpReq.id);
      const key = JSON.stringify([owner, conversation]);
      if (operations.has(key))
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          'A tool call with this request identity is already active.',
        );
      if (options.operations !== undefined && operations.size >= 1024)
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Too many active MCP tool calls. Retry later.');
      const controller = new AbortController();
      operations.set(key, { controller, owner, conversation });
      const signal = AbortSignal.any([request.signal, ctx.mcpReq.signal, controller.signal]);
      const invocationId = randomUUID();
      let skillAccessOpen = true;
      let widgetTool: SessionToolDescriptor | undefined;
      let invocation: SessionMcpInvocation | undefined;
      const publishInvocation = (): void => {
        if (invocation?.sessionId === undefined) return;
        try {
          options.onInvocation?.({ ...invocation });
        } catch {
          // Observability failures must not turn an already executed tool into a retryable failure.
          options.onNotice?.('session MCP call history could not be saved');
        }
      };
      const completeInvocation = (result: CallToolResult): CallToolResult => {
        if (invocation !== undefined) {
          invocation = {
            ...invocation,
            status: signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'succeeded',
            finishedAt: Date.now(),
            output: result.structuredContent ?? result.content,
          };
          publishInvocation();
        }
        return result;
      };
      try {
        const parent = await authorizeOperation();
        const requested = sessionMcpInternalName(prefix, message.params.name);
        invocation = {
          id: invocationId,
          parentSessionId: parent.grant.sessionId,
          clientId: parent.grant.clientId,
          conversationDigest: conversation,
          toolName: requested ?? message.params.name,
          startedAt: Date.now(),
          status: 'running',
          input: message.params.arguments ?? {},
        };
        publishInvocation();
        const wrapper = grantedExtraTools(parent.grant).some((tool) => tool.name === requested);
        const advertised = wrapper
          ? undefined
          : grantedSurface(parent.grant, parent.target.toolSurface).tools.find((tool) => tool.name === requested);
        if (!wrapper && !advertised)
          throw new SessionMcpConversationError(
            'TOOL_NOT_AVAILABLE',
            `Tool '${message.params.name}' is not available on this connection.` +
              (prefix === undefined ? '' : ` Tool names here start with '${prefix}_'.`) +
              nextCall('session_capabilities', ' for the current list.'),
          );
        widgetTool = advertised;
        const wrapperArgs = wrapper ? toolArguments(requested!, message.params.arguments ?? {}, wire) : undefined;
        // A binding must not outlive an unpersisted registration when tools/call precedes tools/list.
        await options.onVerified?.(parent.grant);
        options.onNotice?.(`session MCP invocation id=${invocationId} lifecycle=started`);
        const resolveTarget = async (reserve: boolean) => {
          const active = await authorizeOperation();
          if (!conversation)
            throw new SessionMcpConversationError(
              'CONVERSATION_ID_REQUIRED',
              'This connection requires conversation metadata. Use a compatible ChatGPT conversation and retry.',
            );
          if (!options.resolveConversation)
            throw new SessionMcpConversationError(
              'CONVERSATION_ROUTING_UNAVAILABLE',
              'Conversation routing is unavailable in this host.',
            );
          signal.throwIfAborted();
          const target = await options.resolveConversation(active.grant, conversation, reserve, signal);
          await authorizeOperation();
          signal.throwIfAborted();
          return { grant: active.grant, target };
        };
        if (wrapper && !conversation)
          throw new SessionMcpConversationError(
            'CONVERSATION_ID_REQUIRED',
            'This connection requires conversation metadata. Use a compatible ChatGPT conversation and retry.',
          );
        if (
          (requested === 'load_extra_tools' || requested === 'use_extra_tools') &&
          !baselines.has(parent.grant.clientId)
        )
          throw new SessionMcpConversationError(
            'SESSION_MCP_BASELINE_REQUIRED',
            'Refresh this MCP connection tool catalog before loading or using extra tools.',
          );
        const active = await resolveTarget(true);
        invocation = { ...invocation, sessionId: active.target.sessionId ?? parent.grant.sessionId };
        publishInvocation();
        const { snapshot, tools, skills } = grantedSurface(active.grant, active.target.toolSurface);
        const baseline = baselines.get(parent.grant.clientId);
        const extras = wrapper && baseline ? extraTools(baseline, tools) : [];
        if (requested === 'session_capabilities' && wrapper) {
          const capabilities = {
            sessionId: active.target.sessionId ?? parent.grant.sessionId,
            generation: active.target.generation,
            revision: snapshot.revision,
            baseline: baseline === undefined ? 'missing' : 'available',
            inventory: 'active_surface',
            discovery: 'unknown',
            tools: [...tools.map(publicTool), ...grantedExtraTools(active.grant)].map((tool) => wireTool(prefix, tool)),
            skills: skills.map(({ name, description }) => ({ name, description })),
            ...(active.target.agentLocked === undefined
              ? {}
              : { localAgent: active.target.agentLocked() ? 'locked' : 'unlocked' }),
          };
          const current = await resolveTarget(false);
          if (
            current.target.toolSurface !== active.target.toolSurface ||
            current.target.generation !== active.target.generation ||
            current.target.sessionId !== active.target.sessionId ||
            current.target.toolSurface.readSurface().revision !== snapshot.revision
          )
            throw surfaceChanged();
          options.onNotice?.(`session MCP invocation id=${invocationId} lifecycle=succeeded`);
          return completeInvocation({
            content: [{ type: 'text', text: JSON.stringify(capabilities) }],
            structuredContent: capabilities,
            isError: false,
          });
        }
        if (requested === 'load_extra_tools' && wrapper) {
          const discovery = {
            tools: extras.map((tool) => wireTool(prefix, tool)),
            skills: (tools.some((tool) => tool.name === 'load_skill') ? skills : [])
              .map(({ name, description }) => ({ name, description }))
              .filter(
                (skill) =>
                  !isDeepStrictEqual(
                    baseline!.skills.find((original) => original.name === skill.name),
                    skill,
                  ),
              ),
          };
          const current = await resolveTarget(false);
          if (
            current.target.toolSurface !== active.target.toolSurface ||
            current.target.generation !== active.target.generation ||
            current.target.sessionId !== active.target.sessionId ||
            current.target.toolSurface.readSurface().revision !== snapshot.revision
          )
            throw surfaceChanged();
          options.onNotice?.(`session MCP invocation id=${invocationId} lifecycle=succeeded`);
          return completeInvocation({
            content: [{ type: 'text', text: JSON.stringify(discovery) }],
            structuredContent: discovery,
            isError: false,
          });
        }
        const name = wrapper ? sessionMcpInternalName(prefix, wrapperArgs!.name!) : requested;
        const selected = tools.find((tool) => tool.name === name);
        if (name === undefined || (wrapper && (!extras.some((tool) => tool.name === name) || !selected)))
          throw new SessionMcpConversationError(
            'TOOL_NOT_AVAILABLE',
            `Extra tool '${wrapperArgs?.name ?? message.params.name}' is not available.` +
              nextCall('load_extra_tools', ' and pass a name it returns.'),
          );
        if (
          !wrapper &&
          (!selected ||
            !isDeepStrictEqual(selected.parameters, advertised!.parameters) ||
            !isDeepStrictEqual(selected.outputSchema, advertised!.outputSchema) ||
            !isDeepStrictEqual(selected.annotations, advertised!.annotations) ||
            !isDeepStrictEqual(selected._meta, advertised!._meta))
        )
          throw new SessionMcpConversationError(
            'SESSION_TOOL_SURFACE_CHANGED',
            'The target session does not expose the approved tool contract. Refresh the connection or restore a compatible session selection.',
          );
        widgetTool = wrapper ? undefined : selected;
        const recheck = async () => {
          const current = await resolveTarget(false);
          if (
            current.target.toolSurface !== active.target.toolSurface ||
            current.target.generation !== active.target.generation ||
            current.target.sessionId !== active.target.sessionId
          )
            throw surfaceChanged();
          if (wrapper) {
            if (!grantedExtraTools(current.grant).some((tool) => tool.name === requested)) throw surfaceChanged();
          } else {
            const currentAdvertised = grantedSurface(current.grant, parent.target.toolSurface).tools.find(
              (tool) => tool.name === requested,
            );
            if (!currentAdvertised || !isDeepStrictEqual(currentAdvertised, advertised)) throw surfaceChanged();
          }
          return current;
        };
        const authorizedSkills = async () => {
          if (!skillAccessOpen)
            throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Remote skill access is no longer active.');
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
            if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Skill is not granted or active.');
            const text = await active.target.toolSurface.readSkill(current.snapshot.revision, skill.uri);
            signal.throwIfAborted();
            const after = await authorizedSkills();
            if (after.snapshot.revision !== current.snapshot.revision) throw surfaceChanged();
            return text;
          },
        };
        invocation = {
          ...invocation,
          toolName: name,
          input: wrapper ? (wrapperArgs!.arguments ?? {}) : (message.params.arguments ?? {}),
        };
        publishInvocation();
        let result: Awaited<ReturnType<SessionToolSurface['invokeTool']>>;
        try {
          result = await active.target.toolSurface.invokeTool({
            revision: snapshot.revision,
            name,
            arguments: wrapper ? (wrapperArgs!.arguments ?? {}) : (message.params.arguments ?? {}),
            signal,
            mcpSkills,
            authorize: async () => {
              const current = await recheck();
              if (wrapper) {
                const currentTool = grantedSurface(current.grant, current.target.toolSurface).tools.find(
                  (tool) => tool.name === name,
                );
                if (!currentTool || !isDeepStrictEqual(currentTool, selected)) throw surfaceChanged();
              }
            },
          });
        } catch (error) {
          if (signal.aborted || error instanceof ProtocolError || error instanceof SessionMcpConversationError)
            throw error;
          // After-hooks can fail once execution finished, so never claim the call did not run.
          throw new SessionMcpConversationError(
            'TOOL_CALL_FAILED',
            `${wire(name)} did not return a result: ${error instanceof Error ? error.message : 'unknown error'}. ` +
              'If the tool changes files or state, inspect before retrying.',
          );
        }
        try {
          await recheck();
        } catch (error) {
          if (!(error instanceof SessionMcpConversationError)) throw error;
          throw new SessionMcpConversationError(
            'SESSION_RESULT_WITHHELD',
            'The call may have run, but its result was withheld because the session tools or grants changed. ' +
              'Inspect state before retrying.',
          );
        }
        options.onNotice?.(`session MCP invocation id=${invocationId} lifecycle=succeeded`);
        return completeInvocation(
          widgetResult(
            wrapper ? undefined : selected,
            {
              content:
                active.target.agentLocked?.() === false
                  ? [...result.content, { type: 'text', text: LOCAL_AGENT_UNLOCKED_NOTICE }]
                  : result.content,
              ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
              ...(result._meta === undefined ? {} : { _meta: result._meta }),
              isError: result.isError ?? false,
            },
            prefix,
          ),
        );
      } catch (error) {
        // The cause is logged because the client may drop the answer, for example on a timeout
        // during a first call that provisions a worktree, and then nothing else records why. Only a
        // class or code: a message can carry tool arguments, which notices never do.
        const cause =
          error instanceof SessionMcpConversationError
            ? error.code
            : signal.aborted
              ? 'aborted'
              : error instanceof ProtocolError
                ? `mcp_${String(error.code)}`
                : error instanceof Error
                  ? error.name
                  : 'unknown';
        options.onNotice?.(`session MCP invocation id=${invocationId} lifecycle=failed cause=${cause}`);
        if (invocation !== undefined) {
          invocation = {
            ...invocation,
            status: signal.aborted ? 'cancelled' : 'failed',
            finishedAt: Date.now(),
            output: { cause, message: error instanceof Error ? error.message : 'Tool call failed.' },
          };
          publishInvocation();
        }
        if (!(error instanceof SessionMcpConversationError)) throw error;
        return widgetResult(
          widgetTool,
          {
            content: [{ type: 'text', text: error.message }],
            isError: true,
            structuredContent: {
              code: error.code,
              message: error.message,
              ...(error.bindingId === undefined ? {} : { bindingId: error.bindingId }),
            },
          },
          prefix,
        );
      } finally {
        skillAccessOpen = false;
        operations.delete(key);
      }
    });
    server.setRequestHandler('resources/list', async () => {
      const active = await authorizeOperation();
      const { uiResources } = grantedSurface(active.grant, active.target.toolSurface);
      return {
        resources: [...uiResources],
      };
    });
    server.setRequestHandler('resources/read', async (message, ctx) => {
      const conversation = sessionMcpConversationDigest(
        ctx.mcpReq._meta ?? (message.params as { _meta?: unknown })._meta,
      );
      const active = await authorizeOperation();
      const { snapshot, skills, uiResources } = grantedSurface(active.grant, active.target.toolSurface);
      const skill = skills.find((candidate) => candidate.uri === message.params.uri);
      if (skill !== undefined) {
        if (!conversation)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            `Use ${wire('load_skill')} with conversation metadata to read target-session guidance.`,
          );
        if (!options.resolveConversation)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            'Conversation routing is unavailable in this host.',
          );
        const target = await options.resolveConversation(active.grant, conversation, false, request.signal);
        const text = await target.toolSurface.readSkill(snapshot.revision, skill.uri);
        await authorizeOperation();
        return { contents: [{ uri: skill.uri, mimeType: 'text/markdown', text }] };
      }
      const resource = uiResources.find((candidate) => candidate.uri === message.params.uri);
      if (resource !== undefined && active.target.toolSurface.readUiResource !== undefined) {
        // Templates are immutable and session-independent, so hosts may prefetch them without a conversation ID.
        request.signal.throwIfAborted();
        const text = await active.target.toolSurface.readUiResource(snapshot.revision, resource.uri);
        request.signal.throwIfAborted();
        const current = await authorizeOperation();
        const after = grantedSurface(current.grant, current.target.toolSurface);
        if (
          current.target.toolSurface !== active.target.toolSurface ||
          after.snapshot.revision !== snapshot.revision ||
          !isDeepStrictEqual(
            after.uiResources.find((candidate) => candidate.uri === resource.uri),
            resource,
          )
        )
          throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'The session UI resource surface has changed.');
        return { contents: [{ ...resource, text }] };
      }
      if (message.params.uri.startsWith('ui:'))
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'UI resource is not granted or active.');
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Use ${wire('load_skill')} with conversation metadata to read target-session guidance.`,
      );
    });

    // One server per request, as before. Only the 2026-07-28 revision is served; a 2025-era request
    // is refused with the versions this endpoint supports.
    const handler = createMcpHandler(() => server, { legacy: 'reject' });
    try {
      return await handler.fetch(request, {
        authInfo: {
          token,
          clientId: grant.clientId,
          scopes:
            grant.scope === 'session'
              ? ['session']
              : [...grant.tools.map((name) => `tool:${name}`), ...grant.skills.map((name) => `skill:${name}`)],
          expiresAt: Math.floor(grant.expiresAt / 1000),
          resource: new URL(exactResource),
        },
      });
    } catch {
      return jsonError(500, 'Internal MCP server error.');
    }
  };
}
