import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createSessionMcpAuthorizationService,
  SessionMcpOAuthError,
} from '../../../../src/services/sessionMcpAuthorization';

const CALLBACK = 'https://client.example/callback';
const AUDIENCE = 'https://host.example/sessions/alpha/mcp';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function fixture() {
  let now = 10_000;
  const service = createSessionMcpAuthorizationService({
    now: () => now,
    authorizationCodeTtlMs: 100,
    accessTokenTtlMs: 200,
    refreshTokenTtlMs: 300,
  });
  const client = service.createClient({ name: 'Owner client', redirectUri: CALLBACK });
  service.createAuthorizationBinding({
    clientId: client.clientId,
    sessionId: 'alpha',
    sessionGeneration: 4,
    audience: AUDIENCE,
    tools: ['read', 'read'],
    skills: ['review'],
  });
  const issue = () =>
    service.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: CALLBACK,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
  const exchange = (code: string, codeVerifier = VERIFIER) =>
    service.exchangeToken({
      grantType: 'authorization_code',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      redirectUri: CALLBACK,
      codeVerifier,
    });
  return { service, client, issue, exchange, advance: (milliseconds: number) => (now += milliseconds) };
}

describe('session MCP restricted OAuth', () => {
  it('creates local confidential clients with exact HTTPS callbacks and no retained secret', () => {
    const { service, client } = fixture();

    expect(client.tokenEndpointAuthMethod).toBe('client_secret_post');
    expect(service.readClient(client.clientId)).toEqual({
      clientId: client.clientId,
      name: 'Owner client',
      redirectUri: CALLBACK,
      tokenEndpointAuthMethod: 'client_secret_post',
      createdAt: 10_000,
    });
    expect(service.readClient(`${client.clientId}/metadata`)).toBeUndefined();
    expect(() => service.createClient({ name: 'unsafe', redirectUri: 'http://localhost/callback' })).toThrow(
      SessionMcpOAuthError,
    );
  });

  it('requires exact callback, confidential client auth, and S256 PKCE', () => {
    const { service, client, issue, exchange } = fixture();

    expect(() =>
      service.issueAuthorizationCode({
        clientId: client.clientId,
        redirectUri: `${CALLBACK}/other`,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
    ).toThrow('Redirect URI does not exactly match');

    const authorization = issue();
    expect(() => exchange(authorization.code, 'x'.repeat(43))).toThrow('Authorization code is invalid or expired');
    expect(() => exchange(authorization.code)).toThrow('Authorization code is invalid or expired');
  });

  it('mints expiring audience-bound tokens, rotates refresh tokens, and consumes codes once', () => {
    const { service, client, issue, exchange, advance } = fixture();
    const authorization = issue();
    const tokens = exchange(authorization.code);

    expect(tokens.grant).toMatchObject({
      sessionId: 'alpha',
      sessionGeneration: 4,
      audience: AUDIENCE,
      tools: ['read'],
      skills: ['review'],
    });
    expect(() => exchange(authorization.code)).toThrow('Authorization code is invalid or expired');
    expect(service.authenticateAccessToken(tokens.accessToken, `${AUDIENCE}/wrong`)).toBeUndefined();
    expect(service.authenticateAccessToken(tokens.accessToken, AUDIENCE)).toMatchObject({ id: tokens.grant.id });

    const rotated = service.exchangeToken({
      grantType: 'refresh_token',
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: tokens.refreshToken,
    });
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    advance(201);
    expect(() =>
      service.exchangeToken({
        grantType: 'refresh_token',
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: tokens.refreshToken,
      }),
    ).toThrow('Refresh token is invalid or expired');
    expect(service.authenticateAccessToken(tokens.accessToken, AUDIENCE)).toBeUndefined();
    expect(service.authenticateAccessToken(rotated.accessToken, AUDIENCE)).toBeUndefined();
    expect(() =>
      service.exchangeToken({
        grantType: 'refresh_token',
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: rotated.refreshToken,
      }),
    ).toThrow('Refresh token is invalid or expired');
  });

  it('cascade revokes codes, access tokens, and refresh tokens by generation or client', () => {
    const first = fixture();
    const firstAuthorization = first.issue();
    const firstTokens = first.exchange(firstAuthorization.code);

    expect(first.service.revokeSessionGeneration('alpha', 4)).toBe(1);
    expect(first.service.authenticateAccessToken(firstTokens.accessToken, AUDIENCE)).toBeUndefined();
    expect(() =>
      first.service.exchangeToken({
        grantType: 'refresh_token',
        clientId: first.client.clientId,
        clientSecret: first.client.clientSecret,
        refreshToken: firstTokens.refreshToken,
      }),
    ).toThrow('Refresh token is invalid or expired');

    const second = fixture();
    const pending = second.issue();
    expect(second.service.revokeClient(second.client.clientId)).toBe(true);
    expect(() => second.exchange(pending.code)).toThrow('Client authentication failed');
  });

  it('stores one immutable owner binding and rejects query-bearing audiences', () => {
    const { service, client, issue } = fixture();
    const binding = service.readAuthorizationBinding(client.clientId);

    expect(binding).toMatchObject({ tools: ['read'], skills: ['review'], audience: AUDIENCE });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding?.tools)).toBe(true);
    expect(issue().grant).toMatchObject(binding!);
    expect(() =>
      service.createAuthorizationBinding({
        clientId: client.clientId,
        sessionId: 'other',
        sessionGeneration: 5,
        audience: 'https://host.example/other',
        tools: ['hidden'],
        skills: [],
      }),
    ).toThrow('already bound');

    const other = service.createClient({ name: 'Other', redirectUri: CALLBACK });
    expect(() =>
      service.createAuthorizationBinding({
        clientId: other.clientId,
        sessionId: 'alpha',
        sessionGeneration: 4,
        audience: `${AUDIENCE}?widen=true`,
        tools: [],
        skills: [],
      }),
    ).toThrow('without credentials, a query, or a fragment');
  });

  it('sweeps expired codes and orphan grants before enforcing the record bound', () => {
    let now = 1_000;
    const service = createSessionMcpAuthorizationService({
      now: () => now,
      authorizationCodeTtlMs: 10,
      maxRecords: 3,
    });
    const client = service.createClient({ name: 'Bounded', redirectUri: CALLBACK });
    service.createAuthorizationBinding({
      clientId: client.clientId,
      sessionId: 'alpha',
      sessionGeneration: 1,
      audience: AUDIENCE,
      tools: [],
      skills: [],
    });
    const first = service.issueAuthorizationCode({
      clientId: client.clientId,
      redirectUri: CALLBACK,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });

    expect(() =>
      service.issueAuthorizationCode({
        clientId: client.clientId,
        redirectUri: CALLBACK,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
    ).toThrow('at capacity');
    now += 11;
    expect(
      service.issueAuthorizationCode({
        clientId: client.clientId,
        redirectUri: CALLBACK,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }).code,
    ).toBeTypeOf('string');
    expect(service.revokeGrant(first.grant.id)).toBe(false);
  });

  it('expires unredeemed authorization codes', () => {
    const { issue, exchange, advance } = fixture();
    const authorization = issue();
    advance(101);
    expect(() => exchange(authorization.code)).toThrow('Authorization code is invalid or expired');
  });
});
