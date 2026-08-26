import { describe, expect, it, vi } from 'vitest';
import { createProviderAuth } from '../../src/adapters/providerAuth.ts';
import { createFakeAuthRuntime, tick } from '../support/fakeAuthRuntime.ts';

function setup() {
  const runtime = createFakeAuthRuntime();
  const notices: string[] = [];
  const auth = createProviderAuth({ runtime: async () => runtime, onNotice: (message) => notices.push(message) });
  return { runtime, auth, notices };
}

describe('createProviderAuth', () => {
  it('lists providers by name with their methods and auth state, re-reading first', async () => {
    const { runtime, auth } = setup();
    const providers = await auth.listProviders();
    expect(runtime.refreshes).toBe(1);
    expect(providers).toEqual([
      { id: 'bedrock', name: 'Amazon Bedrock', methods: [], authenticated: { type: 'api_key', source: 'AWS_PROFILE' } },
      {
        id: 'anthropic',
        name: 'Anthropic',
        methods: [
          { type: 'oauth', label: 'Anthropic (Claude Pro/Max)' },
          { type: 'api_key', label: 'Anthropic API key' },
        ],
      },
      { id: 'zeta', name: 'Zeta', methods: [{ type: 'oauth', label: 'Sign in with Zeta' }] },
    ]);
  });

  it('still lists on a failed refresh and says so', async () => {
    const { runtime, auth, notices } = setup();
    runtime.refresh = async () => {
      throw new Error('models.json is unreadable');
    };
    await expect(auth.listProviders()).resolves.toHaveLength(3);
    expect(notices).toEqual(['provider auth refresh failed: models.json is unreadable']);
  });

  it('runs an api-key login through prompt and answer to an authenticated provider', async () => {
    const { runtime, auth, notices } = setup();
    const started = await auth.startLogin('anthropic', 'api_key');
    if (!started.ok) throw new Error(started.error);
    expect(started.flow).toMatchObject({ providerId: 'anthropic', providerName: 'Anthropic', type: 'api_key' });
    await tick();
    const waiting = auth.getLogin(started.flow.id);
    expect(waiting?.prompt).toEqual({ id: '1', type: 'secret', message: 'Enter anthropic key' });

    expect(auth.answerLogin(started.flow.id, '1', 'sk-test')).toBe('answered');
    await tick();
    expect(auth.getLogin(started.flow.id)?.status).toBe('succeeded');
    expect(runtime.logins).toEqual([{ providerId: 'anthropic', type: 'api_key' }]);
    expect(notices).toContain('signed in to Anthropic (api_key)');

    const anthropic = (await auth.listProviders()).find((provider) => provider.id === 'anthropic');
    expect(anthropic?.authenticated).toEqual({ type: 'api_key', source: 'stored' });
  });

  it('relays oauth events and reports the oauth method once stored', async () => {
    const { auth } = setup();
    const started = await auth.startLogin('zeta', 'oauth');
    if (!started.ok) throw new Error(started.error);
    await tick();
    const flow = auth.getLogin(started.flow.id);
    expect(flow?.events).toEqual([{ type: 'auth_url', url: 'https://zeta.example/authorize' }]);
    expect(flow?.prompt).toMatchObject({ type: 'manual_code' });
    auth.answerLogin(started.flow.id, '1', 'code-1');
    await tick();
    expect(auth.getLogin(started.flow.id)).toMatchObject({
      status: 'succeeded',
      events: [
        { type: 'auth_url', url: 'https://zeta.example/authorize' },
        { type: 'progress', message: 'exchanging code-1' },
      ],
    });
    const zeta = (await auth.listProviders()).find((provider) => provider.id === 'zeta');
    expect(zeta?.authenticated).toEqual({ type: 'oauth', source: 'stored' });
  });

  it('marks a refused login as failed with the cause', async () => {
    const { auth } = setup();
    const started = await auth.startLogin('anthropic', 'api_key');
    if (!started.ok) throw new Error(started.error);
    await tick();
    auth.answerLogin(started.flow.id, '1', 'bad');
    await tick();
    expect(auth.getLogin(started.flow.id)).toMatchObject({ status: 'failed', error: 'The key was refused.' });
  });

  it('refuses unknown providers, missing methods, and a second concurrent login', async () => {
    const { auth } = setup();
    await expect(auth.startLogin('nope', 'api_key')).resolves.toMatchObject({ ok: false, code: 'unknown_provider' });
    await expect(auth.startLogin('bedrock', 'api_key')).resolves.toMatchObject({
      ok: false,
      code: 'unsupported_method',
    });
    await expect(auth.startLogin('zeta', 'api_key')).resolves.toMatchObject({ ok: false, code: 'unsupported_method' });
    const first = await auth.startLogin('anthropic', 'api_key');
    expect(first.ok).toBe(true);
    await expect(auth.startLogin('anthropic', 'oauth')).resolves.toMatchObject({ ok: false, code: 'busy' });
    // Another provider is free to start meanwhile.
    await expect(auth.startLogin('zeta', 'oauth')).resolves.toMatchObject({ ok: true });
  });

  it('cancels a running flow and forgets finished ones on the next start', async () => {
    const { auth } = setup();
    const started = await auth.startLogin('anthropic', 'api_key');
    if (!started.ok) throw new Error(started.error);
    await tick();
    expect(auth.cancelLogin(started.flow.id)?.status).toBe('cancelled');
    await tick();
    expect(auth.getLogin(started.flow.id)?.status).toBe('cancelled');
    expect(auth.cancelLogin('missing')).toBeUndefined();

    const next = await auth.startLogin('anthropic', 'api_key');
    expect(next.ok).toBe(true);
    expect(auth.getLogin(started.flow.id)).toBeUndefined();
  });

  it('answers only a flow that is waiting', async () => {
    const { auth } = setup();
    expect(auth.answerLogin('missing', '1', 'x')).toBe('unknown_flow');
    const started = await auth.startLogin('anthropic', 'api_key');
    if (!started.ok) throw new Error(started.error);
    await tick();
    expect(auth.answerLogin(started.flow.id, '2', 'x')).toBe('not_waiting');
    expect(auth.answerLogin(started.flow.id, '1', 'x')).toBe('answered');
    expect(auth.answerLogin(started.flow.id, '1', 'x')).toBe('not_waiting');
  });

  it('logs out a provider and reports runtime failures', async () => {
    const { runtime, auth, notices } = setup();
    runtime.stored.add('anthropic');
    await expect(auth.logout('nope')).resolves.toMatchObject({ ok: false, code: 'unknown_provider' });
    await expect(auth.logout('anthropic')).resolves.toEqual({ ok: true });
    expect(runtime.stored.has('anthropic')).toBe(false);
    expect(notices).toContain('signed out of Anthropic');
    runtime.logoutError = new Error('auth.json is locked');
    await expect(auth.logout('anthropic')).resolves.toEqual({
      ok: false,
      code: 'runtime',
      error: 'auth.json is locked',
    });
  });

  it('retries a failed runtime load on the next call and loads only once after', async () => {
    const runtime = createFakeAuthRuntime();
    const load = vi
      .fn<() => Promise<typeof runtime>>()
      .mockRejectedValueOnce(new Error('pi is missing'))
      .mockResolvedValue(runtime);
    const auth = createProviderAuth({ runtime: load });
    await expect(auth.listProviders()).rejects.toThrow('pi is missing');
    await expect(auth.listProviders()).resolves.toHaveLength(3);
    await expect(auth.listProviders()).resolves.toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('close abandons every running flow', async () => {
    const { auth } = setup();
    const started = await auth.startLogin('anthropic', 'api_key');
    if (!started.ok) throw new Error(started.error);
    auth.close();
    expect(auth.getLogin(started.flow.id)).toBeUndefined();
  });
});
