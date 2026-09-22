import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const CLIENT_ID_BYTES = 18;
const CLIENT_SECRET_BYTES = 32;
const DEFAULT_MAX_RECORDS = 10_000;
const GRANT_ID_BYTES = 18;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const TOKEN_BYTES = 32;

export type SessionMcpOAuthErrorCode =
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_request'
  | 'unsupported_grant_type';

export class SessionMcpOAuthError extends Error {
  readonly code: SessionMcpOAuthErrorCode;

  constructor(code: SessionMcpOAuthErrorCode, message: string) {
    super(message);
    this.name = 'SessionMcpOAuthError';
    this.code = code;
  }
}

export type SessionMcpScope = 'restricted' | 'session';
export type SessionMcpRouting = 'conversation';

/**
 * Conversation routing is mandatory. Legacy registrations are migrated at read time
 * so they cannot continue to share their parent runtime.
 */
export function sessionMcpRouting(value: unknown): SessionMcpRouting {
  if (value === undefined || value === 'session' || value === 'conversation') return 'conversation';
  throw new SessionMcpOAuthError('invalid_request', 'Session MCP routing is not supported.');
}

export interface SessionMcpClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUri: string;
  readonly tokenEndpointAuthMethod: 'client_secret_post';
  readonly createdAt: number;
}

export interface CreatedSessionMcpClient extends SessionMcpClient {
  /** Returned once. Only a SHA-256 digest is retained by the service. */
  readonly clientSecret: string;
}

export interface SessionMcpAuthorizationBinding {
  readonly clientId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly audience: string;
  readonly scope: SessionMcpScope;
  /** Always conversation. Legacy persisted values are normalized at read time. */
  readonly routing?: SessionMcpRouting;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

export type CreateSessionMcpAuthorizationBindingInput = Omit<
  SessionMcpAuthorizationBinding,
  'scope' | 'tools' | 'skills'
> &
  (
    | { readonly scope: 'session'; readonly tools?: never; readonly skills?: never }
    | { readonly scope?: 'restricted'; readonly tools: readonly string[]; readonly skills: readonly string[] }
  );

export interface SessionMcpGrant extends SessionMcpAuthorizationBinding {
  readonly id: string;
  readonly createdAt: number;
}

export interface SessionMcpAccessGrant extends SessionMcpGrant {
  readonly expiresAt: number;
}

export interface SessionMcpTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly grant: SessionMcpGrant;
}

export interface SessionMcpAuthorizationServiceOptions {
  readonly now?: () => number;
  readonly authorizationCodeTtlMs?: number;
  readonly accessTokenTtlMs?: number;
  readonly refreshTokenTtlMs?: number;
  /** Maximum combined authorization codes, grants, tokens, and refresh-token tombstones. */
  readonly maxRecords?: number;
}

export interface CreateSessionMcpClientInput {
  readonly name: string;
  readonly redirectUri: string;
}

export interface IssueSessionMcpAuthorizationCodeInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
}

export type SessionMcpTokenRequest =
  | {
      readonly grantType: 'authorization_code';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly code: string;
      readonly redirectUri: string;
      readonly codeVerifier: string;
    }
  | {
      readonly grantType: 'refresh_token';
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
    };

export interface SessionMcpAuthorizationCode {
  readonly code: string;
  readonly grant: SessionMcpGrant;
  readonly expiresAt: number;
}

export interface SessionMcpPersistentRegistration {
  readonly client: SessionMcpClient;
  readonly secretHash: string;
  readonly workspaceId: string;
  readonly binding: Omit<SessionMcpAuthorizationBinding, 'sessionGeneration'>;
  readonly verifiedAt: number;
}

export interface SessionMcpAuthorizationService {
  createClient(input: CreateSessionMcpClientInput): CreatedSessionMcpClient;
  readClient(clientId: string): SessionMcpClient | undefined;
  listClients(): readonly SessionMcpClient[];
  revokeClient(clientId: string): boolean;
  createAuthorizationBinding(input: CreateSessionMcpAuthorizationBindingInput): SessionMcpAuthorizationBinding;
  readAuthorizationBinding(clientId: string): SessionMcpAuthorizationBinding | undefined;
  persistentRegistration(
    clientId: string,
    workspaceId: string,
    verifiedAt: number,
  ): SessionMcpPersistentRegistration | undefined;
  restorePersistentRegistration(registration: SessionMcpPersistentRegistration, sessionGeneration: number): boolean;
  issueAuthorizationCode(input: IssueSessionMcpAuthorizationCodeInput): SessionMcpAuthorizationCode;
  exchangeToken(request: SessionMcpTokenRequest): SessionMcpTokenResponse;
  authenticateAccessToken(token: string, audience: string): SessionMcpAccessGrant | undefined;
  revokeGrant(grantId: string): boolean;
  revokeSessionGeneration(sessionId: string, sessionGeneration: number): number;
  revokeSession(sessionId: string): number;
}

interface StoredClient extends SessionMcpClient {
  readonly secretHash: Buffer;
}

interface StoredCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly grant: SessionMcpGrant;
  readonly expiresAt: number;
}

interface StoredAccessToken {
  readonly grant: SessionMcpGrant;
  readonly familyId: string;
  readonly expiresAt: number;
}

interface StoredRefreshToken extends StoredAccessToken {
  readonly familyExpiresAt: number;
}

interface ConsumedRefreshToken {
  readonly clientId: string;
  readonly grantId: string;
  readonly familyId: string;
  readonly expiresAt: number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenKey(value: string): string {
  return digest(value).toString('hex');
}

function opaque(bytes = TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

function exactSecret(actual: string, expectedHash: Buffer): boolean {
  return timingSafeEqual(digest(actual), expectedHash);
}

function requireHttpsUrl(value: string, label: string, allowQuery: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SessionMcpOAuthError('invalid_request', `${label} must be an absolute HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    (!allowQuery && parsed.search !== '')
  ) {
    throw new SessionMcpOAuthError(
      'invalid_request',
      `${label} must be an absolute HTTPS URL without credentials, a query, or a fragment.`,
    );
  }
  return parsed.href;
}

function requireName(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new SessionMcpOAuthError('invalid_request', `${label} must not be empty.`);
  return normalized;
}

function exactUniqueGrants(values: readonly string[], label: string): readonly string[] {
  if (values.some((value) => value === '' || value !== value.trim())) {
    throw new SessionMcpOAuthError('invalid_request', `${label} grants must contain exact non-empty names.`);
  }
  return Object.freeze([...new Set(values)]);
}

/** In-memory restricted OAuth authority. It intentionally has no discovery or client registration surface. */
export function createSessionMcpAuthorizationService(
  options: SessionMcpAuthorizationServiceOptions = {},
): SessionMcpAuthorizationService {
  const now = options.now ?? Date.now;
  const codeTtl = options.authorizationCodeTtlMs ?? AUTHORIZATION_CODE_TTL_MS;
  const accessTtl = options.accessTokenTtlMs ?? ACCESS_TOKEN_TTL_MS;
  const refreshTtl = options.refreshTokenTtlMs ?? REFRESH_TOKEN_TTL_MS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 3) {
    throw new Error('Session MCP authorization maxRecords must be a safe integer of at least 3.');
  }

  const clients = new Map<string, StoredClient>();
  const bindings = new Map<string, SessionMcpAuthorizationBinding>();
  const grants = new Map<string, SessionMcpGrant>();
  const codes = new Map<string, StoredCode>();
  const accessTokens = new Map<string, StoredAccessToken>();
  const refreshTokens = new Map<string, StoredRefreshToken>();
  const consumedRefreshTokens = new Map<string, ConsumedRefreshToken>();

  const publicClient = ({ secretHash: _secretHash, ...client }: StoredClient): SessionMcpClient => client;

  const recordCount = (): number =>
    grants.size + codes.size + accessTokens.size + refreshTokens.size + consumedRefreshTokens.size;

  const sweep = (): void => {
    const currentTime = now();
    for (const [key, value] of codes) if (value.expiresAt <= currentTime) codes.delete(key);
    for (const [key, value] of accessTokens) if (value.expiresAt <= currentTime) accessTokens.delete(key);
    for (const [key, value] of refreshTokens) if (value.expiresAt <= currentTime) refreshTokens.delete(key);
    for (const [key, value] of consumedRefreshTokens) {
      if (value.expiresAt <= currentTime) consumedRefreshTokens.delete(key);
    }

    const referencedGrants = new Set<string>();
    for (const value of codes.values()) referencedGrants.add(value.grant.id);
    for (const value of accessTokens.values()) referencedGrants.add(value.grant.id);
    for (const value of refreshTokens.values()) referencedGrants.add(value.grant.id);
    for (const value of consumedRefreshTokens.values()) referencedGrants.add(value.grantId);
    for (const grantId of grants.keys()) if (!referencedGrants.has(grantId)) grants.delete(grantId);
  };

  const requireCapacity = (additionalRecords: number): void => {
    sweep();
    if (recordCount() + additionalRecords > maxRecords) {
      throw new SessionMcpOAuthError('invalid_request', 'The authorization service is at capacity.');
    }
  };

  const authenticateClient = (clientId: string, clientSecret: string): StoredClient => {
    const client = clients.get(clientId);
    if (client === undefined || !exactSecret(clientSecret, client.secretHash)) {
      throw new SessionMcpOAuthError('invalid_client', 'Client authentication failed.');
    }
    return client;
  };

  const revokeGrant = (grantId: string): boolean => {
    if (!grants.delete(grantId)) return false;
    for (const [key, value] of codes) if (value.grant.id === grantId) codes.delete(key);
    for (const [key, value] of accessTokens) if (value.grant.id === grantId) accessTokens.delete(key);
    for (const [key, value] of refreshTokens) if (value.grant.id === grantId) refreshTokens.delete(key);
    return true;
  };

  const revokeFamily = (familyId: string, grantId: string): void => {
    revokeGrant(grantId);
    for (const [key, value] of accessTokens) if (value.familyId === familyId) accessTokens.delete(key);
    for (const [key, value] of refreshTokens) if (value.familyId === familyId) refreshTokens.delete(key);
  };

  const mintTokens = (
    grant: SessionMcpGrant,
    familyId = opaque(GRANT_ID_BYTES),
    familyExpiresAt = now() + refreshTtl,
  ): SessionMcpTokenResponse => {
    const issuedAt = now();
    const accessExpiresAt = Math.min(issuedAt + accessTtl, familyExpiresAt);
    const accessToken = opaque();
    const refreshToken = opaque();
    accessTokens.set(tokenKey(accessToken), { grant, familyId, expiresAt: accessExpiresAt });
    refreshTokens.set(tokenKey(refreshToken), {
      grant,
      familyId,
      expiresAt: familyExpiresAt,
      familyExpiresAt,
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.max(0, Math.floor((accessExpiresAt - issuedAt) / 1000)),
      grant,
    };
  };

  return {
    createClient(input) {
      const createdAt = now();
      const clientId = opaque(CLIENT_ID_BYTES);
      const clientSecret = opaque(CLIENT_SECRET_BYTES);
      const client: StoredClient = {
        clientId,
        name: requireName(input.name, 'Client name'),
        redirectUri: requireHttpsUrl(input.redirectUri, 'Redirect URI', true),
        tokenEndpointAuthMethod: 'client_secret_post',
        createdAt,
        secretHash: digest(clientSecret),
      };
      clients.set(clientId, client);
      return { ...publicClient(client), clientSecret };
    },
    readClient(clientId) {
      const client = clients.get(clientId);
      return client === undefined ? undefined : publicClient(client);
    },
    listClients() {
      return [...clients.values()].map(publicClient);
    },
    revokeClient(clientId) {
      if (!clients.delete(clientId)) return false;
      bindings.delete(clientId);
      for (const grant of grants.values()) if (grant.clientId === clientId) revokeGrant(grant.id);
      return true;
    },
    createAuthorizationBinding(input) {
      if (!clients.has(input.clientId)) throw new SessionMcpOAuthError('invalid_client', 'Unknown local client.');
      if (bindings.has(input.clientId)) {
        throw new SessionMcpOAuthError('invalid_request', 'Client authorization is already bound.');
      }
      if (!Number.isSafeInteger(input.sessionGeneration) || input.sessionGeneration < 0) {
        throw new SessionMcpOAuthError('invalid_request', 'Session generation must be a non-negative safe integer.');
      }
      const routing = sessionMcpRouting(input.routing);
      const scope = input.scope ?? 'restricted';
      if (scope !== 'session' && scope !== 'restricted') {
        throw new SessionMcpOAuthError('invalid_request', 'Authorization scope is not supported.');
      }
      let tools: readonly string[];
      let skills: readonly string[];
      if (scope === 'session') {
        if (input.tools !== undefined || input.skills !== undefined) {
          throw new SessionMcpOAuthError('invalid_request', 'Session scope cannot include capability grants.');
        }
        tools = Object.freeze([] as string[]);
        skills = Object.freeze([] as string[]);
      } else {
        if (!Array.isArray(input.tools) || !Array.isArray(input.skills)) {
          throw new SessionMcpOAuthError('invalid_request', 'Restricted scope requires tool and skill grants.');
        }
        tools = exactUniqueGrants(input.tools, 'Tool');
        skills = exactUniqueGrants(input.skills, 'Skill');
      }
      const binding: SessionMcpAuthorizationBinding = Object.freeze({
        clientId: input.clientId,
        sessionId: requireName(input.sessionId, 'Session ID'),
        sessionGeneration: input.sessionGeneration,
        audience: requireHttpsUrl(input.audience, 'Audience', false),
        scope,
        routing,
        tools,
        skills,
      });
      bindings.set(input.clientId, binding);
      return binding;
    },
    readAuthorizationBinding(clientId) {
      return bindings.get(clientId);
    },
    persistentRegistration(clientId, workspaceId, verifiedAt) {
      const client = clients.get(clientId);
      const binding = bindings.get(clientId);
      if (client === undefined || binding === undefined || !Number.isSafeInteger(verifiedAt)) return undefined;
      const { sessionGeneration: _sessionGeneration, ...persistentBinding } = binding;
      return {
        client: publicClient(client),
        secretHash: client.secretHash.toString('hex'),
        workspaceId: requireName(workspaceId, 'Workspace ID'),
        binding: persistentBinding,
        verifiedAt,
      };
    },
    restorePersistentRegistration(registration, sessionGeneration) {
      if (
        bindings.has(registration.client.clientId) ||
        !/^[a-f0-9]{64}$/u.test(registration.secretHash) ||
        !Number.isSafeInteger(sessionGeneration) ||
        sessionGeneration < 0 ||
        registration.client.clientId !== registration.binding.clientId
      )
        return false;
      try {
        // Restarting a runtime revokes its binding, not its durable client registration.
        const held = clients.get(registration.client.clientId);
        if (
          held &&
          (held.redirectUri !== registration.client.redirectUri ||
            !timingSafeEqual(held.secretHash, Buffer.from(registration.secretHash, 'hex')))
        )
          return false;
        const client: StoredClient = {
          clientId: requireName(registration.client.clientId, 'Client ID'),
          name: requireName(registration.client.name, 'Client name'),
          redirectUri: requireHttpsUrl(registration.client.redirectUri, 'Redirect URI', true),
          tokenEndpointAuthMethod: 'client_secret_post',
          createdAt: registration.client.createdAt,
          secretHash: Buffer.from(registration.secretHash, 'hex'),
        };
        const routing = sessionMcpRouting(registration.binding.routing);
        const scope = registration.binding.scope;
        const tools =
          scope === 'session' ? Object.freeze([] as string[]) : exactUniqueGrants(registration.binding.tools, 'Tool');
        const skills =
          scope === 'session' ? Object.freeze([] as string[]) : exactUniqueGrants(registration.binding.skills, 'Skill');
        if (
          (scope !== 'session' && scope !== 'restricted') ||
          (scope === 'session' && (registration.binding.tools.length !== 0 || registration.binding.skills.length !== 0))
        ) {
          throw new SessionMcpOAuthError('invalid_request', 'Stored Session MCP authorization is invalid.');
        }
        clients.set(client.clientId, client);
        bindings.set(
          client.clientId,
          Object.freeze({
            clientId: client.clientId,
            sessionId: requireName(registration.binding.sessionId, 'Session ID'),
            sessionGeneration,
            audience: requireHttpsUrl(registration.binding.audience, 'Audience', false),
            scope,
            routing,
            tools,
            skills,
          }),
        );
        return true;
      } catch {
        clients.delete(registration.client.clientId);
        return false;
      }
    },
    issueAuthorizationCode(input) {
      const client = clients.get(input.clientId);
      if (client === undefined) throw new SessionMcpOAuthError('invalid_client', 'Unknown local client.');
      const binding = bindings.get(input.clientId);
      if (binding === undefined) {
        throw new SessionMcpOAuthError('invalid_request', 'Client authorization has not been preauthorized.');
      }
      if (input.redirectUri !== client.redirectUri) {
        throw new SessionMcpOAuthError(
          'invalid_request',
          'Redirect URI does not exactly match the registered callback.',
        );
      }
      if (input.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/u.test(input.codeChallenge)) {
        throw new SessionMcpOAuthError('invalid_request', 'A valid S256 PKCE challenge is required.');
      }
      requireCapacity(2);
      const issuedAt = now();
      const grant: SessionMcpGrant = Object.freeze({
        id: opaque(GRANT_ID_BYTES),
        ...binding,
        createdAt: issuedAt,
      });
      const code = opaque();
      const expiresAt = issuedAt + codeTtl;
      grants.set(grant.id, grant);
      codes.set(tokenKey(code), {
        clientId: client.clientId,
        redirectUri: client.redirectUri,
        challenge: input.codeChallenge,
        grant,
        expiresAt,
      });
      return { code, grant, expiresAt };
    },
    exchangeToken(request) {
      authenticateClient(request.clientId, request.clientSecret);
      sweep();
      if (request.grantType === 'authorization_code') {
        const codeKey = tokenKey(request.code);
        const stored = codes.get(codeKey);
        if (
          stored === undefined ||
          stored.expiresAt <= now() ||
          stored.clientId !== request.clientId ||
          stored.redirectUri !== request.redirectUri ||
          !/^[A-Za-z0-9\-._~]{43,128}$/u.test(request.codeVerifier) ||
          createHash('sha256').update(request.codeVerifier).digest('base64url') !== stored.challenge ||
          !grants.has(stored.grant.id)
        ) {
          codes.delete(codeKey);
          if (stored !== undefined) revokeGrant(stored.grant.id);
          throw new SessionMcpOAuthError('invalid_grant', 'Authorization code is invalid or expired.');
        }
        requireCapacity(1);
        codes.delete(codeKey);
        return mintTokens(stored.grant);
      }
      if (request.grantType === 'refresh_token') {
        const refreshKey = tokenKey(request.refreshToken);
        const replayed = consumedRefreshTokens.get(refreshKey);
        if (replayed !== undefined) {
          if (replayed.clientId === request.clientId && replayed.expiresAt > now()) {
            revokeFamily(replayed.familyId, replayed.grantId);
          }
          throw new SessionMcpOAuthError('invalid_grant', 'Refresh token is invalid or expired.');
        }
        const stored = refreshTokens.get(refreshKey);
        if (
          stored === undefined ||
          stored.expiresAt <= now() ||
          stored.grant.clientId !== request.clientId ||
          !grants.has(stored.grant.id)
        ) {
          refreshTokens.delete(refreshKey);
          throw new SessionMcpOAuthError('invalid_grant', 'Refresh token is invalid or expired.');
        }
        requireCapacity(2);
        refreshTokens.delete(refreshKey);
        consumedRefreshTokens.set(refreshKey, {
          clientId: stored.grant.clientId,
          grantId: stored.grant.id,
          familyId: stored.familyId,
          expiresAt: stored.familyExpiresAt,
        });
        return mintTokens(stored.grant, stored.familyId, stored.familyExpiresAt);
      }
      throw new SessionMcpOAuthError(
        'unsupported_grant_type',
        'Only authorization_code and refresh_token are supported.',
      );
    },
    authenticateAccessToken(token, audience) {
      sweep();
      const key = tokenKey(token);
      const stored = accessTokens.get(key);
      if (stored === undefined) return undefined;
      if (stored.expiresAt <= now() || !grants.has(stored.grant.id)) {
        accessTokens.delete(key);
        return undefined;
      }
      if (stored.grant.audience !== audience) return undefined;
      return { ...stored.grant, expiresAt: stored.expiresAt };
    },
    revokeGrant,
    revokeSessionGeneration(sessionId, sessionGeneration) {
      let revoked = 0;
      for (const grant of grants.values()) {
        if (grant.sessionId === sessionId && grant.sessionGeneration === sessionGeneration && revokeGrant(grant.id)) {
          revoked += 1;
        }
      }
      for (const [clientId, binding] of bindings) {
        if (binding.sessionId === sessionId && binding.sessionGeneration === sessionGeneration)
          bindings.delete(clientId);
      }
      return revoked;
    },
    revokeSession(sessionId) {
      let revoked = 0;
      for (const grant of grants.values()) {
        if (grant.sessionId === sessionId && revokeGrant(grant.id)) revoked += 1;
      }
      for (const [clientId, binding] of bindings) if (binding.sessionId === sessionId) bindings.delete(clientId);
      return revoked;
    },
  };
}
