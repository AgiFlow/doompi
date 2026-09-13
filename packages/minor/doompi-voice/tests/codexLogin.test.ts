/*
 * Tests for the TypeScript port of OpenAI Codex login at commit 5ecb3afd1b.
 * Copyright OpenAI. Licensed under the Apache License, Version 2.0.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CodexAuthTransaction, CodexOwnedAuthStorage } from '../src/services/codexAuth';
import { createCodexLogin } from '../src/services/codexLogin';

const signal = new AbortController().signal;
const idToken = `e30.${Buffer.from(
  JSON.stringify({
    chatgpt_account_id: 'wrong-top-level-account',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-owned' },
  }),
).toString('base64url')}.signature`;

function storage(): CodexOwnedAuthStorage & { raw: string | null } {
  return {
    raw: null,
    async read() {
      return this.raw;
    },
    async runExclusive<T>(_signal: AbortSignal, operation: (transaction: CodexAuthTransaction) => Promise<T>) {
      return operation({ read: () => this.read(signal), write: async (value) => void (this.raw = value) });
    },
  };
}

describe('DoomPi Codex OAuth login', () => {
  it('builds PKCE/state authorization and commits exchanged tokens to the owned store', async () => {
    const owned = storage();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: idToken,
          access_token: 'access-owned',
          refresh_token: 'refresh-owned',
        }),
      ),
    );
    let byte = 0;
    const login = createCodexLogin({
      storage: owned,
      fetch: fetchImpl,
      randomBytes: (length) => Uint8Array.from({ length }, () => ++byte),
      now: () => new Date(0),
    });
    const attempt = login.begin('http://127.0.0.1:1455/auth/callback');
    const authorize = new URL(attempt.authorizationUrl);
    expect(authorize.origin).toBe('https://auth.openai.com');
    expect(authorize.pathname).toBe('/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.has('originator')).toBe(false);
    expect(authorize.searchParams.has('codex_cli_simplified_flow')).toBe(false);
    const state = authorize.searchParams.get('state')!;

    await attempt.complete(
      `http://127.0.0.1:1455/auth/callback?code=offline-code&state=${encodeURIComponent(state)}`,
      signal,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    const request = fetchImpl.mock.calls[0]![1]!;
    const body = request.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('offline-code');
    expect(body.get('code_verifier')).toHaveLength(86);
    expect(JSON.parse(owned.raw!)).toMatchObject({
      auth_mode: 'chatgpt',
      doompi_auth_owner: 'doompi',
      tokens: { access_token: 'access-owned', refresh_token: 'refresh-owned', account_id: 'account-owned' },
    });
  });

  it('rejects state mismatch and provider callback errors before exchange', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const login = createCodexLogin({
      storage: storage(),
      fetch: fetchImpl,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      now: () => new Date(0),
    });
    const mismatch = login.begin('http://localhost:1455/auth/callback');
    await expect(
      mismatch.complete('http://localhost:1455/auth/callback?code=x&state=wrong', signal),
    ).rejects.toMatchObject({ code: 'state_mismatch' });
    // An unrelated callback must not consume the valid attempt.
    const state = new URL(mismatch.authorizationUrl).searchParams.get('state');
    await expect(
      mismatch.complete(`http://localhost:1455/auth/callback?error=access_denied&state=${state}`, signal),
    ).rejects.toMatchObject({ code: 'authorization_rejected' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-loopback redirects and token endpoint redirects', async () => {
    const login = createCodexLogin({
      storage: storage(),
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 302 })),
      randomBytes: (length) => new Uint8Array(length).fill(9),
      now: () => new Date(0),
    });
    expect(() => login.begin('https://example.com/callback')).toThrow(
      expect.objectContaining({ code: 'redirect_uri_invalid' }),
    );
    const attempt = login.begin('http://localhost:1455/auth/callback');
    const state = new URL(attempt.authorizationUrl).searchParams.get('state');
    await expect(
      attempt.complete(`http://localhost:1455/auth/callback?code=x&state=${state}`, signal),
    ).rejects.toMatchObject({ code: 'token_exchange_redirected' });
  });

  it('rejects malformed redirect and callback inputs before any effect', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const makeLogin = () =>
      createCodexLogin({
        storage: storage(),
        fetch: fetchImpl,
        randomBytes: (length) => new Uint8Array(length).fill(11),
        now: () => new Date(0),
      });
    for (const redirect of [
      'not-a-url',
      'http://user:pass@localhost:1455/callback',
      'http://localhost:1455/callback?query=x',
      'http://localhost:1455/callback#fragment',
    ]) {
      expect(() => makeLogin().begin(redirect)).toThrow(expect.objectContaining({ code: 'redirect_uri_invalid' }));
    }
    const wrongTarget = makeLogin().begin('http://localhost:1455/auth/callback');
    const wrongState = new URL(wrongTarget.authorizationUrl).searchParams.get('state');
    await expect(
      wrongTarget.complete(`http://localhost:1455/wrong?code=x&state=${wrongState}`, signal),
    ).rejects.toMatchObject({ code: 'callback_invalid' });
    const duplicate = makeLogin().begin('http://localhost:1455/auth/callback');
    const duplicateState = new URL(duplicate.authorizationUrl).searchParams.get('state');
    await expect(
      duplicate.complete(
        `http://localhost:1455/auth/callback?code=x&state=${duplicateState}&state=${duplicateState}`,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'callback_invalid' });
    const missingCode = makeLogin().begin('http://localhost:1455/auth/callback');
    const missingCodeState = new URL(missingCode.authorizationUrl).searchParams.get('state');
    await expect(
      missingCode.complete(`http://localhost:1455/auth/callback?state=${missingCodeState}`, signal),
    ).rejects.toMatchObject({ code: 'authorization_code_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an insufficient random source', () => {
    const login = createCodexLogin({
      storage: storage(),
      fetch: vi.fn(),
      randomBytes: () => new Uint8Array(),
      now: () => new Date(0),
    });
    expect(() => login.begin('http://localhost:1455/auth/callback')).toThrow(
      expect.objectContaining({ code: 'login_random_invalid' }),
    );
  });
});
