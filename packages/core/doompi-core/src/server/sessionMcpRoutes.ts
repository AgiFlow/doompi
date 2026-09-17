import {
  createSessionMcpAuthorizationService,
  SessionMcpOAuthError,
  type SessionMcpAuthorizationBinding,
  type SessionMcpAuthorizationService,
  type SessionMcpClient,
} from '../services/sessionMcpAuthorization';
import type { HeadlessHub, HeadlessHubSession } from './headlessHub';
import { createSessionMcpHttpHandler } from './sessionMcpHandler';

const AUTHORIZATION_SERVER_DISCOVERY = '/.well-known/oauth-authorization-server';
const AUTHORIZE_ROUTE = '/oauth/authorize';
const TOKEN_ROUTE = '/oauth/token';
const SESSION_MCP_PATTERN = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp$/u;
const SESSION_MCP_CONFIG_PATTERN = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp\/config$/u;
const SESSION_MCP_CLIENTS_PATTERN = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp\/clients(?:\/([^/]+))?$/u;
const PROTECTED_RESOURCE_PATTERN =
  /^\/\.well-known\/oauth-protected-resource(\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/mcp)$/u;

export interface SessionMcpRoutesOptions {
  readonly headlessHub: HeadlessHub;
  readonly publicOrigin: () => string | undefined;
  readonly publicOriginRevision?: () => number;
  readonly authorization?: SessionMcpAuthorizationService;
}

export interface SessionMcpRoutes {
  handlePublic(request: Request): Promise<Response | undefined>;
  handleHost(request: Request): Promise<Response | undefined>;
  close(): void;
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function oauthError(error: unknown): Response {
  if (error instanceof SessionMcpOAuthError)
    return json(error.code === 'invalid_client' ? 401 : 400, {
      error: error.code,
      error_description: error.message,
    });
  return json(400, { error: 'invalid_request', error_description: 'The OAuth request was invalid.' });
}

function trustedOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.pathname === '/' && url.search === '' && url.hash === ''
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function sessionPath(workspaceId: string, sessionId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/mcp`;
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function publicClient(client: SessionMcpClient, binding: SessionMcpAuthorizationBinding): Record<string, unknown> {
  return {
    ...client,
    tools: binding.tools,
    skills: binding.skills,
    audience: binding.audience,
  };
}

/** Routes the process-local session MCP authority and revokes every grant with its live incarnation. */
export function createSessionMcpRoutes(options: SessionMcpRoutesOptions): SessionMcpRoutes {
  const authorization = options.authorization ?? createSessionMcpAuthorizationService();
  const incarnations = new Map<string, { host: HeadlessHubSession['host']; generation: number }>();
  let nextGeneration = 1;

  const revokeIncarnation = (sessionId: string, generation: number): void => {
    authorization.revokeSessionGeneration(sessionId, generation);
  };
  const register = (session: HeadlessHubSession): void => {
    const current = incarnations.get(session.id);
    if (current?.host === session.host) return;
    if (current !== undefined) revokeIncarnation(session.id, current.generation);
    incarnations.set(session.id, { host: session.host, generation: nextGeneration++ });
  };
  for (const session of options.headlessHub.snapshot()) register(session);
  const unsubscribe = options.headlessHub.onEvent((event) => {
    if (event.kind === 'upsert') register(event.session);
    if (event.kind === 'removed') {
      const current = incarnations.get(event.sessionId);
      if (current !== undefined) revokeIncarnation(event.sessionId, current.generation);
      incarnations.delete(event.sessionId);
    }
  });

  let observedOrigin: string | undefined;
  let observedOriginRevision: number | undefined;
  let originObserved = false;
  const origin = (): string | undefined => {
    const current = trustedOrigin(options.publicOrigin());
    const revision = options.publicOriginRevision?.();
    if (
      (originObserved && current !== observedOrigin) ||
      (revision !== undefined && observedOriginRevision !== undefined && revision !== observedOriginRevision)
    ) {
      for (const client of authorization.listClients()) authorization.revokeClient(client.clientId);
    }
    observedOrigin = current;
    observedOriginRevision = revision;
    originObserved = true;
    return current;
  };
  const target = (workspaceId: string, sessionId: string) => {
    const session = options.headlessHub.session(sessionId);
    const incarnation = incarnations.get(sessionId);
    return session !== undefined && session.workspaceId === workspaceId && incarnation?.host === session.host
      ? { session, generation: incarnation.generation }
      : undefined;
  };

  const publicRoutes = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const configuredOrigin = origin();
    const mcpMatch = SESSION_MCP_PATTERN.exec(url.pathname);
    if (mcpMatch !== null) {
      if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
      const workspaceId = decodeURIComponent(mcpMatch[1]);
      const sessionId = decodeURIComponent(mcpMatch[2]);
      const exactPath = sessionPath(workspaceId, sessionId);
      if (url.pathname !== exactPath || url.search !== '') return json(404, { error: 'Not found.' });
      const audience = `${configuredOrigin}${exactPath}`;
      const handler = createSessionMcpHttpHandler({
        audience,
        authorization,
        resourceMetadataUrl: `${configuredOrigin}/.well-known/oauth-protected-resource${exactPath}`,
        resolveSession: (grantedSessionId) => {
          if (grantedSessionId !== sessionId) return undefined;
          const resolved = target(workspaceId, sessionId);
          return resolved === undefined
            ? undefined
            : { generation: resolved.generation, toolSurface: resolved.session.host.toolSurface };
        },
      });
      return handler(new Request(audience, request));
    }

    const protectedMatch = PROTECTED_RESOURCE_PATTERN.exec(url.pathname);
    if (protectedMatch !== null && request.method === 'GET') {
      if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
      return json(200, {
        resource: `${configuredOrigin}${protectedMatch[1]}`,
        authorization_servers: [configuredOrigin],
        bearer_methods_supported: ['header'],
      });
    }
    if (url.pathname === AUTHORIZATION_SERVER_DISCOVERY && request.method === 'GET') {
      if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
      return json(200, {
        issuer: configuredOrigin,
        authorization_endpoint: `${configuredOrigin}${AUTHORIZE_ROUTE}`,
        token_endpoint: `${configuredOrigin}${TOKEN_ROUTE}`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (url.pathname === AUTHORIZE_ROUTE && request.method === 'GET') {
      if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
      const clientId = url.searchParams.get('client_id') ?? '';
      const client = authorization.readClient(clientId);
      const binding = authorization.readAuthorizationBinding(clientId);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (client === undefined || binding === undefined || redirectUri !== client.redirectUri) {
        return oauthError(new SessionMcpOAuthError('invalid_client', 'Unknown client or callback.'));
      }
      const callback = new URL(client.redirectUri);
      const state = url.searchParams.get('state');
      try {
        const boundSession = options.headlessHub.session(binding.sessionId);
        const boundIncarnation = incarnations.get(binding.sessionId);
        const expectedAudience =
          boundSession?.workspaceId === undefined
            ? undefined
            : `${configuredOrigin}${sessionPath(boundSession.workspaceId, binding.sessionId)}`;
        if (
          expectedAudience === undefined ||
          binding.audience !== expectedAudience ||
          boundIncarnation?.host !== boundSession?.host ||
          binding.sessionGeneration !== boundIncarnation?.generation
        ) {
          authorization.revokeClient(clientId);
          throw new SessionMcpOAuthError('invalid_grant', 'The preauthorized session is no longer active.');
        }
        if (url.searchParams.get('response_type') !== 'code')
          throw new SessionMcpOAuthError('invalid_request', 'Only the code response type is supported.');
        if (url.searchParams.get('resource') !== null && url.searchParams.get('resource') !== binding.audience)
          throw new SessionMcpOAuthError('invalid_request', 'The requested resource is not preauthorized.');
        const code = authorization.issueAuthorizationCode({
          clientId,
          redirectUri,
          codeChallenge: url.searchParams.get('code_challenge') ?? '',
          codeChallengeMethod: url.searchParams.get('code_challenge_method') as 'S256',
        });
        callback.searchParams.set('code', code.code);
      } catch (error) {
        callback.searchParams.set('error', error instanceof SessionMcpOAuthError ? error.code : 'invalid_request');
        callback.searchParams.set(
          'error_description',
          error instanceof Error ? error.message : 'The OAuth request was invalid.',
        );
      }
      if (state !== null) callback.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { location: callback.href, 'cache-control': 'no-store' } });
    }
    if (url.pathname === TOKEN_ROUTE && request.method === 'POST') {
      try {
        const form = await request.formData();
        const grantType = formString(form, 'grant_type');
        const clientId = formString(form, 'client_id');
        const clientSecret = formString(form, 'client_secret');
        const result =
          grantType === 'authorization_code'
            ? authorization.exchangeToken({
                grantType,
                clientId,
                clientSecret,
                code: formString(form, 'code'),
                redirectUri: formString(form, 'redirect_uri'),
                codeVerifier: formString(form, 'code_verifier'),
              })
            : grantType === 'refresh_token'
              ? authorization.exchangeToken({
                  grantType,
                  clientId,
                  clientSecret,
                  refreshToken: formString(form, 'refresh_token'),
                })
              : (() => {
                  throw new SessionMcpOAuthError('unsupported_grant_type', 'The grant type is not supported.');
                })();
        return json(200, {
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          token_type: result.tokenType,
          expires_in: result.expiresIn,
        });
      } catch (error) {
        return oauthError(error);
      }
    }
    return undefined;
  };

  return {
    handlePublic: publicRoutes,
    async handleHost(request) {
      const url = new URL(request.url);
      origin();
      const configMatch = SESSION_MCP_CONFIG_PATTERN.exec(url.pathname);
      const match = SESSION_MCP_CLIENTS_PATTERN.exec(url.pathname);
      if (configMatch === null && match === null) return undefined;
      const routeMatch = configMatch ?? match!;
      const workspaceId = decodeURIComponent(routeMatch[1]);
      const sessionId = decodeURIComponent(routeMatch[2]);
      const clientId = match?.[3] === undefined ? undefined : decodeURIComponent(match[3]);
      const resolved = target(workspaceId, sessionId);
      if (resolved === undefined) return json(404, { error: 'Session not found.' });
      if (configMatch !== null) {
        if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
        const configuredOrigin = origin();
        if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
        let surface;
        try {
          surface = resolved.session.host.toolSurface.readSurface();
        } catch {
          return json(409, { error: 'The session capability surface is not ready.' });
        }
        return json(200, {
          audience: `${configuredOrigin}${sessionPath(workspaceId, sessionId)}`,
          authorizationEndpoint: `${configuredOrigin}${AUTHORIZE_ROUTE}`,
          tokenEndpoint: `${configuredOrigin}${TOKEN_ROUTE}`,
          tools: surface.tools.map(({ name, label, description }) => ({ name, label, description })),
          skills: surface.skills,
        });
      }
      if (clientId === undefined && request.method === 'GET') {
        return json(200, {
          clients: authorization.listClients().flatMap((client) => {
            const binding = authorization.readAuthorizationBinding(client.clientId);
            return binding?.sessionId === sessionId ? [publicClient(client, binding)] : [];
          }),
        });
      }
      if (clientId === undefined && request.method === 'POST') {
        if (origin() === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json(400, { error: 'Invalid client request.' });
        }
        if (typeof body !== 'object' || body === null) return json(400, { error: 'Invalid client request.' });
        const input = body as Record<string, unknown>;
        const tools = parseStringArray(input.tools);
        const skills = parseStringArray(input.skills);
        if (typeof input.name !== 'string' || typeof input.redirectUri !== 'string' || !tools || !skills)
          return json(400, { error: 'A name, redirectUri, tools, and skills are required.' });
        let surface;
        try {
          surface = resolved.session.host.toolSurface.readSurface();
        } catch {
          return json(409, { error: 'The session capability surface is not ready.' });
        }
        const activeTools = new Set(surface.tools.map((tool) => tool.name));
        const activeSkills = new Set(surface.skills.map((skill) => skill.name));
        if (tools.some((name) => !activeTools.has(name)) || skills.some((name) => !activeSkills.has(name)))
          return json(400, { error: 'Every requested grant must be active in the session.' });
        try {
          const client = authorization.createClient({ name: input.name, redirectUri: input.redirectUri });
          const audience = `${origin()!}${sessionPath(workspaceId, sessionId)}`;
          try {
            const binding = authorization.createAuthorizationBinding({
              clientId: client.clientId,
              sessionId,
              sessionGeneration: resolved.generation,
              audience,
              tools: [...new Set(tools)],
              skills: [...new Set(skills)],
            });
            return json(201, { client: publicClient(client, binding) });
          } catch (error) {
            authorization.revokeClient(client.clientId);
            throw error;
          }
        } catch (error) {
          return oauthError(error);
        }
      }
      if (clientId !== undefined && request.method === 'DELETE') {
        const binding = authorization.readAuthorizationBinding(clientId);
        if (binding?.sessionId !== sessionId) return json(404, { error: 'Client not found.' });
        authorization.revokeClient(clientId);
        return json(200, { ok: true });
      }
      return json(405, { error: 'Method not allowed.' });
    },
    close() {
      unsubscribe();
      for (const [sessionId, incarnation] of incarnations) revokeIncarnation(sessionId, incarnation.generation);
      incarnations.clear();
    },
  };
}

export function isPublicSessionMcpRoute(method: string, pathname: string): boolean {
  return (
    SESSION_MCP_PATTERN.test(pathname) ||
    (method === 'GET' && PROTECTED_RESOURCE_PATTERN.test(pathname)) ||
    (method === 'GET' && (pathname === AUTHORIZATION_SERVER_DISCOVERY || pathname === AUTHORIZE_ROUTE)) ||
    (method === 'POST' && pathname === TOKEN_ROUTE)
  );
}

export function isSessionMcpHostRoute(pathname: string): boolean {
  return SESSION_MCP_CONFIG_PATTERN.test(pathname) || SESSION_MCP_CLIENTS_PATTERN.test(pathname);
}
