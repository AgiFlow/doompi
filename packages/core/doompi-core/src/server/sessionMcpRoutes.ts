import fs from 'node:fs';
import path from 'node:path';

import type { DoomHubSessionReservations, DoomHubSessionScope } from '../schemas/hubChannel';
import {
  createSessionMcpAuthorizationService,
  SessionMcpOAuthError,
  sessionMcpRouting,
  type SessionMcpAuthorizationBinding,
  type SessionMcpAuthorizationService,
  type SessionMcpClient,
} from '../services/sessionMcpAuthorization';
import { SessionMcpConversationError, type SessionMcpConversationStore } from '../services/sessionMcpConversations';
import type { SessionMcpRegistrationStore } from '../services/sessionMcpRegistrationStore';
import type { HeadlessHub, HeadlessHubSession } from './headlessHub';
import { createSessionMcpHttpHandler, type SessionMcpHttpHandler } from './sessionMcpHandler';

const AUTHORIZATION_SERVER_DISCOVERY = '/.well-known/oauth-authorization-server';
const AUTHORIZE_ROUTE = '/oauth/authorize';
const TOKEN_ROUTE = '/oauth/token';
const SESSION_MCP_PATTERN = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp$/u;
const SESSION_MCP_URL_TOKEN_PATTERN =
  /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;
const SESSION_MCP_CONFIG_PATTERN = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp\/config$/u;
const SESSION_MCP_CLIENTS_PATTERN = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp\/clients(?:\/([^/]+))?$/u;
const SESSION_MCP_CONVERSATIONS_PATTERN =
  /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mcp\/conversations(?:\/([^/]+))?$/u;
const PROTECTED_RESOURCE_PATTERN =
  /^\/\.well-known\/oauth-protected-resource(\/api\/workspaces\/[^/]+\/sessions\/[^/]+\/mcp)$/u;

export interface SessionMcpRoutesOptions {
  readonly headlessHub: HeadlessHub;
  readonly publicOrigin: () => string | undefined;
  readonly publicOriginRevision?: () => number;
  readonly authorization?: SessionMcpAuthorizationService;
  readonly registrationStore?: SessionMcpRegistrationStore;
  readonly conversationStore?: SessionMcpConversationStore;
  readonly isSessionPersisted?: (sessionId: string, cwd: string) => boolean;
  readonly onNotice?: (message: string) => void;
}

export interface SessionMcpRoutes {
  handlePublic(request: Request): Promise<Response | undefined>;
  handleHost(request: Request): Promise<Response | undefined>;
  readonly reservations: DoomHubSessionReservations;
  closeSessionBinding(sessionId: string): void;
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

function defaultClientName(origin: string): string {
  return `ChatGPT · ${new URL(origin).hostname}`;
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function publicClient(client: SessionMcpClient, binding: SessionMcpAuthorizationBinding): Record<string, unknown> {
  return {
    clientId: client.clientId,
    name: client.name,
    redirectUri: client.redirectUri,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
    createdAt: client.createdAt,
    scope: binding.scope,
    routing: sessionMcpRouting(binding.routing),
    tools: binding.tools,
    skills: binding.skills,
    audience: binding.audience,
  };
}

/** Canonicalizes an intended directory without creating it or accepting symlink aliases. */
function executionDirectory(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0') || value.length > 4096)
    throw new SessionMcpConversationError('INVALID_EXECUTION_DIRECTORY', 'Choose an absolute execution directory.');
  let ancestor = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(ancestor), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor)
        throw new SessionMcpConversationError(
          'INVALID_EXECUTION_DIRECTORY',
          'The execution directory cannot be resolved.',
        );
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

function overlappingDirectories(left: string, right: string): boolean {
  const contained = (root: string, target: string): boolean => {
    const relative = path.relative(root, target);
    return (
      relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  return contained(left, right) || contained(right, left);
}

/** Routes the process-local session MCP authority and revokes every grant with its live incarnation. */
export function createSessionMcpRoutes(options: SessionMcpRoutesOptions): SessionMcpRoutes {
  const authorization = options.authorization ?? createSessionMcpAuthorizationService();
  const incarnations = new Map<
    string,
    { host: HeadlessHubSession['host']; generation: number; handlers: Map<string, SessionMcpHttpHandler> }
  >();
  let nextGeneration = 1;
  let publishPending = (): void => {};

  const revokeIncarnation = (sessionId: string, generation: number): void => {
    authorization.revokeSessionGeneration(sessionId, generation);
  };
  const register = (session: HeadlessHubSession): void => {
    const current = incarnations.get(session.id);
    if (current?.host === session.host) return;
    if (current !== undefined) revokeIncarnation(session.id, current.generation);
    incarnations.set(session.id, { host: session.host, generation: nextGeneration++, handlers: new Map() });
  };
  for (const session of options.headlessHub.snapshot()) register(session);
  const unsubscribe = options.headlessHub.onEvent((event) => {
    if (event.kind === 'upsert') {
      register(event.session);
      publishPending();
    }
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
      for (const client of authorization.listClients()) {
        authorization.revokeClient(client.clientId);
        options.registrationStore?.remove(client.clientId);
      }
      for (const incarnation of incarnations.values()) incarnation.handlers.clear();
    }
    observedOrigin = current;
    observedOriginRevision = revision;
    originObserved = true;
    restorePersistedRegistrations(current);
    return current;
  };
  const target = (workspaceId: string, sessionId: string) => {
    // Remote MCP clients cannot inherit a grant, including through conversation child routing.
    if (options.headlessHub.computerUse?.ownsSession?.(sessionId)) return undefined;
    const session = options.headlessHub.session(sessionId);
    const incarnation = incarnations.get(sessionId);
    return session !== undefined && session.workspaceId === workspaceId && incarnation?.host === session.host
      ? { session, generation: incarnation.generation }
      : undefined;
  };
  const restorePersistedRegistrations = (configuredOrigin: string | undefined): void => {
    if (configuredOrigin === undefined) return;
    for (const registration of options.registrationStore?.registrations() ?? []) {
      const audience = `${configuredOrigin}${sessionPath(registration.workspaceId, registration.binding.sessionId)}`;
      if (registration.binding.audience !== audience) {
        options.registrationStore?.remove(registration.client.clientId);
        continue;
      }
      const resolved = target(registration.workspaceId, registration.binding.sessionId);
      if (resolved !== undefined) authorization.restorePersistentRegistration(registration, resolved.generation);
    }
  };

  const requireStore = (): SessionMcpConversationStore => {
    if (!options.conversationStore)
      throw new SessionMcpConversationError(
        'CONVERSATION_ROUTING_UNAVAILABLE',
        'Persistent conversation routing is unavailable.',
      );
    return options.conversationStore;
  };
  publishPending = () => {
    if (!options.conversationStore) return;
    try {
      const records = options.conversationStore.list();
      for (const parent of options.headlessHub.snapshot())
        options.headlessHub.setPendingSessionSetups?.(
          parent.id,
          records
            .filter((record) => record.parentSessionId === parent.id && record.state === 'pending')
            .map((record) => ({
              id: record.id,
              name: `conversation ${record.id.slice(0, 8)}`,
              createdAt: record.createdAt,
              ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
            })),
        );
    } catch (error) {
      options.onNotice?.(error instanceof Error ? error.message : 'Conversation bindings are unavailable.');
    }
  };
  const readReservation = (id: string, parentSessionId: string) => {
    origin();
    const record = requireStore().get(id, parentSessionId);
    const binding = authorization.readAuthorizationBinding(record.clientId);
    const parent = target(record.parentWorkspaceId, parentSessionId);
    if (
      !parent ||
      binding?.routing !== 'conversation' ||
      binding.sessionId !== parentSessionId ||
      binding.sessionGeneration !== parent.generation
    )
      throw new SessionMcpConversationError(
        'SESSION_UNAVAILABLE',
        'The connection that owns this setup is no longer active.',
        id,
      );
    return { record, parent };
  };
  const reservations: DoomHubSessionReservations = {
    read(id, parentSessionId) {
      const { record } = readReservation(id, parentSessionId);
      return { sessionId: record.id, ...(record.cwd === undefined ? {} : { cwd: record.cwd }) };
    },
    async prepare(id, parentSessionId, suppliedDirectory) {
      const { record, parent } = readReservation(id, parentSessionId);
      const cwd = executionDirectory(suppliedDirectory);
      const parentRoot =
        options.headlessHub.workspaces().find((workspace) => workspace.id === parent.session.workspaceId)?.root ??
        parent.session.cwd;
      const occupied = [
        parentRoot,
        ...options.headlessHub
          .snapshot()
          .filter((session) => session.id !== id)
          .map((session) => session.cwd),
        ...requireStore()
          .list()
          .filter((entry) => entry.id !== id && entry.state !== 'closed' && entry.cwd !== undefined)
          .map((entry) => entry.cwd!),
      ];
      if (occupied.some((directory) => overlappingDirectories(cwd, executionDirectory(directory))))
        throw new SessionMcpConversationError(
          'EXECUTION_DIRECTORY_SHARED',
          'Choose a separate checkout, not a directory shared with another session.',
          id,
        );
      if (record.state === 'bound' && record.cwd !== cwd)
        throw new SessionMcpConversationError(
          'SESSION_TARGET_FIXED',
          'An initialized session cannot change its directory.',
          id,
        );
      requireStore().prepare(id, parentSessionId, cwd);
      publishPending();
      return { sessionId: id, cwd };
    },
    async complete(id, parentSessionId): Promise<DoomHubSessionScope> {
      const { record } = readReservation(id, parentSessionId);
      const child = options.headlessHub.session(id);
      if (
        !record.cwd ||
        !child?.workspaceId ||
        child.parentSessionId !== parentSessionId ||
        executionDirectory(child.cwd) !== record.cwd ||
        options.isSessionPersisted?.(id, child.cwd) === false
      )
        throw new SessionMcpConversationError(
          'SESSION_SETUP_INCOMPLETE',
          'The reserved session is not durably ready. Recover the existing setup instead of creating another checkout.',
          id,
        );
      requireStore().bind(id, parentSessionId, child.workspaceId);
      publishPending();
      return { sessionId: id, workspaceId: child.workspaceId, cwd: child.cwd };
    },
  };
  const provision = new Map<string, Promise<DoomHubSessionScope>>();
  const recoveries = new Map<string, Promise<DoomHubSessionScope>>();
  const setupDirectory = async (
    id: string,
    parentSessionId: string,
    directory: string,
  ): Promise<DoomHubSessionScope> => {
    // A mistyped existing-directory choice must not permanently reserve a nonexistent path.
    const canonical = executionDirectory(directory);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('The execution directory is not a directory.');
    const prepared = await reservations.prepare(id, parentSessionId, canonical);
    const pending = provision.get(id);
    if (pending) return pending;
    const setup = (async () => {
      if (!options.headlessHub.session(id)) {
        const record = requireStore().get(id, parentSessionId);
        if (record.state === 'bound' || options.isSessionPersisted?.(id, prepared.cwd))
          throw new SessionMcpConversationError(
            'SESSION_UNAVAILABLE',
            'Resume the existing session in DoomPi. It will not be recreated automatically.',
            id,
          );
        if (!fs.statSync(prepared.cwd).isDirectory()) throw new Error('The execution directory is not a directory.');
        await options.headlessHub.sessionService.create({
          cwd: prepared.cwd,
          name: `conversation ${id.slice(0, 8)}`,
          parentSessionId,
          sessionProvenance: 'remote-conversation',
          reservationId: id,
        });
      }
      return reservations.complete(id, parentSessionId);
    })();
    provision.set(id, setup);
    try {
      return await setup;
    } finally {
      if (provision.get(id) === setup) provision.delete(id);
    }
  };
  const provisionConversationWorktree = async (
    record: ReturnType<SessionMcpConversationStore['reserve']>,
    signal?: AbortSignal,
  ): Promise<DoomHubSessionScope> => {
    const pending = provision.get(record.id);
    if (pending) return pending;
    const setup = (async () => {
      try {
        const child = await options.headlessHub.sessionService.provisionReservedWorktree?.({
          reservationId: record.id,
          parentSessionId: record.parentSessionId,
          signal,
        });
        if (child === undefined || child.sessionId !== record.id)
          throw new Error('Automatic worktree provisioning did not create the reserved session.');
        return child;
      } catch (error) {
        if (error instanceof SessionMcpConversationError) throw error;
        throw new SessionMcpConversationError(
          'SESSION_WORKTREE_PROVISION_FAILED',
          'An automatic worktree could not be created for this conversation. Resolve the host Git setup, then retry.',
          record.id,
        );
      }
    })();
    provision.set(record.id, setup);
    try {
      return await setup;
    } finally {
      if (provision.get(record.id) === setup) provision.delete(record.id);
    }
  };
  const publicRoutes = async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const configuredOrigin = origin();
    const signedMcpMatch = SESSION_MCP_URL_TOKEN_PATTERN.exec(url.pathname);
    const mcpMatch = SESSION_MCP_PATTERN.exec(url.pathname) ?? signedMcpMatch;
    if (mcpMatch !== null) {
      if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
      const workspaceId = decodeURIComponent(mcpMatch[1]);
      const sessionId = decodeURIComponent(mcpMatch[2]);
      const pathToken = signedMcpMatch?.[3];
      const basePath = sessionPath(workspaceId, sessionId);
      const exactPath = pathToken === undefined ? basePath : `${basePath}/${pathToken}`;
      if (url.pathname !== exactPath || url.search !== '') return json(404, { error: 'Not found.' });
      const audience = `${configuredOrigin}${basePath}`;
      const resource = pathToken === undefined ? audience : `${audience}/${pathToken}`;
      const handlers = target(workspaceId, sessionId) === undefined ? undefined : incarnations.get(sessionId)?.handlers;
      const cachedHandler = pathToken === undefined ? handlers?.get(resource) : undefined;
      const handler =
        cachedHandler ??
        createSessionMcpHttpHandler({
          audience,
          authorization,
          onNotice: options.onNotice,
          ...(pathToken === undefined ? {} : { pathToken }),
          resolveConversation: async (grant, digest, reserve, signal) => {
            const store = requireStore();
            let record = reserve
              ? store.reserve(grant.clientId, sessionId, workspaceId, digest)
              : store.find(grant.clientId, sessionId, digest);
            if (!record)
              throw new SessionMcpConversationError(
                'SESSION_UNAVAILABLE',
                'This conversation binding is unavailable. It will not be recreated automatically.',
              );
            const restoring = recoveries.get(record.id);
            if (restoring) await restoring;
            else {
              const existing = record.workspaceId === undefined ? undefined : target(record.workspaceId, record.id);
              if (record.state === 'closed' || (record.state === 'bound' && !existing)) {
                if (
                  options.headlessHub.session(record.id) ||
                  !record.cwd ||
                  options.isSessionPersisted?.(record.id, record.cwd) !== false
                )
                  throw new SessionMcpConversationError(
                    'SESSION_UNAVAILABLE',
                    'The bound session is unavailable. Resume it in DoomPi; no other session will be used.',
                    record.id,
                  );
                record = store.recover(record.id, sessionId);
                const recovery =
                  record.cwd && fs.existsSync(record.cwd)
                    ? setupDirectory(record.id, sessionId, record.cwd)
                    : provisionConversationWorktree(record, signal);
                recoveries.set(record.id, recovery);
                try {
                  await recovery;
                } finally {
                  if (recoveries.get(record.id) === recovery) recoveries.delete(record.id);
                }
              }
            }
            record = store.find(grant.clientId, sessionId, digest)!;
            if (record.state === 'pending') {
              publishPending();
              if (record.workspaceId !== undefined && options.isSessionPersisted?.(record.id, record.cwd!) !== false)
                throw new SessionMcpConversationError(
                  'SESSION_UNAVAILABLE',
                  'The bound session is unavailable. Resume it in DoomPi; no other session will be used.',
                  record.id,
                );
              const pending = provision.get(record.id);
              if (pending) await pending;
              else if (record.workspaceId !== undefined && record.cwd && fs.existsSync(record.cwd))
                await setupDirectory(record.id, sessionId, record.cwd);
              else await provisionConversationWorktree(record, signal);
              record = store.find(grant.clientId, sessionId, digest);
              if (!record || record.state !== 'bound')
                throw new SessionMcpConversationError(
                  'SESSION_WORKTREE_PROVISION_FAILED',
                  'The automatic worktree setup did not complete. Retry after resolving the host Git setup.',
                );
            }
            const child = record.workspaceId === undefined ? undefined : target(record.workspaceId, record.id);
            if (
              !child ||
              child.session.parentSessionId !== sessionId ||
              executionDirectory(child.session.cwd) !== record.cwd ||
              !fs.existsSync(child.session.cwd)
            )
              throw new SessionMcpConversationError(
                'SESSION_UNAVAILABLE',
                'The bound session is unavailable. Resume it in DoomPi; no other session will be used.',
                record.id,
              );
            return { sessionId: record.id, generation: child.generation, toolSurface: child.session.host.mcpSurface };
          },
          onVerified: (grant) => {
            if (options.registrationStore === undefined) return;
            const active = target(workspaceId, sessionId);
            if (active === undefined || grant.sessionGeneration !== active.generation || grant.clientId === '') {
              throw new Error('The session grant is no longer active.');
            }
            if (authorization.readClient(grant.clientId)?.tokenEndpointAuthMethod !== 'client_secret_post') return;
            const registration = authorization.persistentRegistration(grant.clientId, workspaceId, Date.now());
            if (registration === undefined || !options.registrationStore.save(registration)) {
              throw new Error('The verified Session MCP client could not be saved.');
            }
          },
          ...(pathToken === undefined
            ? { resourceMetadataUrl: `${configuredOrigin}/.well-known/oauth-protected-resource${basePath}` }
            : {}),
          resolveSession: (grantedSessionId) => {
            if (grantedSessionId !== sessionId) return undefined;
            const resolved = target(workspaceId, sessionId);
            return resolved === undefined
              ? undefined
              : { sessionId, generation: resolved.generation, toolSurface: resolved.session.host.mcpSurface };
          },
        });
      if (pathToken === undefined) handlers?.set(resource, handler);
      return handler(new Request(resource, request));
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
      if (
        client === undefined ||
        client.tokenEndpointAuthMethod !== 'client_secret_post' ||
        binding === undefined ||
        redirectUri !== client.redirectUri
      ) {
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

  publishPending();
  return {
    reservations,
    closeSessionBinding(sessionId) {
      options.conversationStore?.closeSession(sessionId);
      publishPending();
    },
    handlePublic: publicRoutes,
    async handleHost(request) {
      const url = new URL(request.url);
      origin();
      const configMatch = SESSION_MCP_CONFIG_PATTERN.exec(url.pathname);
      const match = SESSION_MCP_CLIENTS_PATTERN.exec(url.pathname);
      const conversationMatch = SESSION_MCP_CONVERSATIONS_PATTERN.exec(url.pathname);
      if (configMatch === null && match === null && conversationMatch === null) return undefined;
      const routeMatch = configMatch ?? match ?? conversationMatch!;
      const workspaceId = decodeURIComponent(routeMatch[1]);
      const sessionId = decodeURIComponent(routeMatch[2]);
      const clientId = match?.[3] === undefined ? undefined : decodeURIComponent(match[3]);
      const resolved = target(workspaceId, sessionId);
      if (resolved === undefined) return json(404, { error: 'Session not found.' });
      if (conversationMatch !== null) {
        const id = conversationMatch[3] === undefined ? undefined : decodeURIComponent(conversationMatch[3]);
        try {
          if (request.method === 'GET' && id === undefined)
            return json(200, {
              conversations: requireStore()
                .list()
                .filter((record) => record.parentSessionId === sessionId && record.state !== 'closed')
                .map(({ conversationDigest: _digest, clientId: _clientId, ...record }) => record),
            });
          if (id !== undefined && request.method === 'DELETE') {
            const record = requireStore().get(id, sessionId);
            if (record.state !== 'pending' || options.headlessHub.session(id))
              return json(409, { error: 'Remove the existing session instead.' });
            requireStore().closeSession(id);
            publishPending();
            return json(200, { ok: true });
          }
          if (id !== undefined && request.method === 'POST') {
            const body: unknown = await request.json();
            if (typeof body !== 'object' || body === null || !('cwd' in body) || typeof body.cwd !== 'string')
              return json(400, { error: 'An execution directory is required.' });
            return json(200, { session: await setupDirectory(id, sessionId, body.cwd) });
          }
          return json(405, { error: 'Method not allowed.' });
        } catch (error) {
          return json(409, {
            error:
              error instanceof SessionMcpConversationError
                ? error.message
                : 'Session setup failed. Recover the existing setup before retrying.',
            ...(error instanceof SessionMcpConversationError ? { code: error.code } : {}),
          });
        }
      }
      if (configMatch !== null) {
        if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
        const configuredOrigin = origin();
        if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
        let surface;
        try {
          surface = resolved.session.host.mcpSurface.readSurface();
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
        const configuredOrigin = origin();
        if (configuredOrigin === undefined) return json(503, { error: 'Session MCP public origin is unavailable.' });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json(400, { error: 'Invalid client request.' });
        }
        if (typeof body !== 'object' || body === null) return json(400, { error: 'Invalid client request.' });
        const input = body as Record<string, unknown>;
        if (!options.conversationStore || !options.registrationStore)
          return json(503, { error: 'Mandatory conversation routing requires persistent host state.' });
        if (input.routing !== undefined && input.routing !== 'session' && input.routing !== 'conversation')
          return json(400, { error: 'Session MCP routing is not supported.' });
        const routing = sessionMcpRouting(input.routing);
        const requestedScope = input.scope;
        if (requestedScope !== undefined && requestedScope !== 'session' && requestedScope !== 'restricted') {
          return json(400, { error: 'Authorization scope is not supported.' });
        }
        const scope = requestedScope === 'session' ? 'session' : 'restricted';
        const hasTools = Object.hasOwn(input, 'tools');
        const hasSkills = Object.hasOwn(input, 'skills');
        const tools = parseStringArray(input.tools);
        const skills = parseStringArray(input.skills);
        const authMethod = input.authMethod;
        const apiKey = authMethod === 'api_key';
        const urlToken = authMethod === 'url_token';
        const nonOAuthCredential = apiKey || urlToken;
        if (authMethod !== undefined && authMethod !== 'oauth' && !nonOAuthCredential)
          return json(400, { error: 'Authentication method is not supported.' });
        if (nonOAuthCredential && (scope !== 'session' || Object.hasOwn(input, 'redirectUri')))
          return json(400, { error: 'Signed URLs and API keys require session scope and no redirectUri.' });
        if (!nonOAuthCredential && typeof input.redirectUri !== 'string')
          return json(400, { error: 'A redirectUri is required.' });
        if (scope === 'session' && (hasTools || hasSkills)) {
          return json(400, { error: 'Session scope cannot include capability grants.' });
        }
        if (scope === 'restricted' && (typeof input.name !== 'string' || !tools || !skills)) {
          return json(400, { error: 'Restricted scope requires a name, tools, and skills.' });
        }
        if (scope === 'restricted') {
          let surface;
          try {
            surface = resolved.session.host.mcpSurface.readSurface();
          } catch {
            return json(409, { error: 'The session capability surface is not ready.' });
          }
          const activeTools = new Set(surface.tools.map((tool) => tool.name));
          const activeSkills = new Set(surface.skills.map((skill) => skill.name));
          if (tools!.some((name) => !activeTools.has(name)) || skills!.some((name) => !activeSkills.has(name)))
            return json(400, { error: 'Every requested grant must be active in the session.' });
        }
        try {
          const client = authorization.createClient(
            urlToken
              ? { name: defaultClientName(configuredOrigin), authMethod: 'url_token' }
              : apiKey
                ? { name: typeof input.name === 'string' ? input.name : 'API key', authMethod: 'api_key' }
                : {
                    name: scope === 'session' ? defaultClientName(configuredOrigin) : (input.name as string),
                    redirectUri: input.redirectUri as string,
                  },
          );
          const audience = `${configuredOrigin}${sessionPath(workspaceId, sessionId)}`;
          try {
            const binding =
              scope === 'session'
                ? authorization.createAuthorizationBinding({
                    clientId: client.clientId,
                    sessionId,
                    sessionGeneration: resolved.generation,
                    audience,
                    scope: 'session',
                    routing,
                  })
                : authorization.createAuthorizationBinding({
                    clientId: client.clientId,
                    sessionId,
                    sessionGeneration: resolved.generation,
                    audience,
                    scope: 'restricted',
                    routing,
                    tools: [...new Set(tools!)],
                    skills: [...new Set(skills!)],
                  });
            const connectionUrl = urlToken ? `${audience}/${authorization.issueUrlToken(client.clientId)}` : undefined;
            if (nonOAuthCredential) {
              const registration = authorization.persistentRegistration(client.clientId, workspaceId, Date.now());
              if (registration === undefined || !options.registrationStore.save(registration)) {
                authorization.revokeClient(client.clientId);
                return json(500, { error: 'Session MCP credential could not be saved.' });
              }
            }
            return json(201, {
              client: {
                ...publicClient(client, binding),
                ...(connectionUrl === undefined ? { clientSecret: client.clientSecret } : { connectionUrl }),
              },
            });
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
        if (options.registrationStore !== undefined && !options.registrationStore.remove(clientId)) {
          return json(500, { error: 'Client revocation could not be saved.' });
        }
        authorization.revokeClient(clientId);
        options.conversationStore?.closeClient(clientId);
        publishPending();
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
    SESSION_MCP_URL_TOKEN_PATTERN.test(pathname) ||
    (method === 'GET' && PROTECTED_RESOURCE_PATTERN.test(pathname)) ||
    (method === 'GET' && (pathname === AUTHORIZATION_SERVER_DISCOVERY || pathname === AUTHORIZE_ROUTE)) ||
    (method === 'POST' && pathname === TOKEN_ROUTE)
  );
}

export function isSessionMcpHostRoute(pathname: string): boolean {
  return (
    SESSION_MCP_CONFIG_PATTERN.test(pathname) ||
    SESSION_MCP_CLIENTS_PATTERN.test(pathname) ||
    SESSION_MCP_CONVERSATIONS_PATTERN.test(pathname)
  );
}
