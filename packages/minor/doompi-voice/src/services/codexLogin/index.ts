/*
 * Portions of this file are ported from OpenAI Codex at commit 5ecb3afd1b.
 * Copyright OpenAI. Licensed under the Apache License, Version 2.0.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ORIGIN,
  CODEX_TOKEN_ENDPOINT,
  CodexRealtimeAuthError,
  DOOMPI_AUTH_OWNER,
  isAbort,
  isRecord,
  parseJwtPayload,
  readCodexTokenResponse,
  requiredToken,
  withDeadline,
  type CodexOwnedAuthStorage,
} from '../codexAuth';

const AUTHORIZE_ENDPOINT = `${CODEX_OAUTH_ORIGIN}/oauth/authorize`;
const OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

export interface CodexLoginAttempt {
  readonly authorizationUrl: string;
  complete(callbackUrl: string, signal: AbortSignal): Promise<void>;
}

export interface CodexLoginOptions {
  storage: CodexOwnedAuthStorage;
  fetch: typeof globalThis.fetch;
  randomBytes(length: number): Uint8Array;
  now: () => Date;
  operationTimeoutMs?: number;
}

/**
 * Creates an injected, host-only OAuth adapter. It does not open a browser or
 * start a callback server. The host must supply and route an exact callback URI.
 */
export function createCodexLogin(options: CodexLoginOptions): {
  begin(redirectUri: string): CodexLoginAttempt;
} {
  return {
    begin(redirectUri) {
      validateRedirectUri(redirectUri);
      const verifier = base64Url(options.randomBytes(64));
      const state = base64Url(options.randomBytes(32));
      if (verifier.length < 43 || verifier.length > 128 || state.length < 32)
        throw new CodexRealtimeAuthError('login_random_invalid', 'OAuth random source returned insufficient data.');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorizationUrl = new URL(AUTHORIZE_ENDPOINT);
      authorizationUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: CODEX_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: OAUTH_SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        state,
      }).toString();
      let consumed = false;
      return {
        authorizationUrl: authorizationUrl.toString(),
        async complete(callbackUrl, signal) {
          if (consumed)
            throw new CodexRealtimeAuthError('login_attempt_consumed', 'This sign-in attempt has already completed.');
          signal.throwIfAborted();
          const callback = validateCallback(callbackUrl, redirectUri, state);
          consumed = true;
          await withDeadline(signal, options.operationTimeoutMs, async (boundedSignal) => {
            const body = new URLSearchParams({
              grant_type: 'authorization_code',
              code: callback.code,
              redirect_uri: redirectUri,
              client_id: CODEX_OAUTH_CLIENT_ID,
              code_verifier: verifier,
            });
            let response: Response;
            try {
              response = await options.fetch(CODEX_TOKEN_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                redirect: 'error',
                signal: boundedSignal,
              });
            } catch (error) {
              if (isAbort(error)) throw error;
              throw new CodexRealtimeAuthError('token_exchange_failed', 'Codex authorization-code exchange failed.');
            }
            const tokens = await readCodexTokenResponse(response, boundedSignal, true);
            const idToken = requiredToken(tokens.id_token, 'ID token');
            const claims = parseJwtPayload(idToken)['https://api.openai.com/auth'];
            const accountId = requiredToken(isRecord(claims) ? claims.chatgpt_account_id : undefined, 'account id');
            const document = `${JSON.stringify(
              {
                auth_mode: 'chatgpt',
                doompi_auth_owner: DOOMPI_AUTH_OWNER,
                tokens: {
                  id_token: idToken,
                  access_token: requiredToken(tokens.access_token, 'access token'),
                  refresh_token: requiredToken(tokens.refresh_token, 'refresh token'),
                  account_id: accountId,
                },
                last_refresh: options.now().toISOString(),
              },
              null,
              2,
            )}\n`;
            await options.storage.runExclusive(boundedSignal, (transaction) =>
              transaction.write(document, boundedSignal),
            );
          });
        },
      };
    },
  };
}

function validateRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CodexRealtimeAuthError('redirect_uri_invalid', 'OAuth redirect URI is invalid.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash)
    throw new CodexRealtimeAuthError('redirect_uri_invalid', 'OAuth redirect URI must be a plain loopback HTTP URL.');
}

function validateCallback(callbackUrl: string, redirectUri: string, expectedState: string): { code: string } {
  let callback: URL;
  const redirect = new URL(redirectUri);
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new CodexRealtimeAuthError('callback_invalid', 'OAuth callback URL is invalid.');
  }
  if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname)
    throw new CodexRealtimeAuthError('callback_invalid', 'OAuth callback did not target the configured redirect URI.');
  for (const name of ['state', 'error', 'code'] as const) {
    if (callback.searchParams.getAll(name).length > 1)
      throw new CodexRealtimeAuthError('callback_invalid', 'OAuth callback contained duplicate security parameters.');
  }
  const state = callback.searchParams.get('state');
  const stateBytes = Buffer.from(state ?? '');
  const expectedBytes = Buffer.from(expectedState);
  if (!state || stateBytes.length !== expectedBytes.length || !timingSafeEqual(stateBytes, expectedBytes))
    throw new CodexRealtimeAuthError('state_mismatch', 'OAuth callback state did not match.');
  const oauthError = callback.searchParams.get('error');
  if (oauthError) throw new CodexRealtimeAuthError('authorization_rejected', 'OAuth authorization was rejected.');
  const code = callback.searchParams.get('code');
  if (!code || code.trim() !== code)
    throw new CodexRealtimeAuthError(
      'authorization_code_missing',
      'OAuth callback did not include an authorization code.',
    );
  return { code };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
