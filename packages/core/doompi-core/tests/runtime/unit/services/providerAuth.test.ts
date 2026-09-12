import { describe, expect, it, vi } from 'vitest';
import { createProviderAuth } from '../../../../src/services/providerAuth';
import type { AuthRuntime, LoginInteraction } from '../../../../src/types/server/auth';

function runtime(): AuthRuntime {
  return {
    getProviders: () => [
      {
        id: 'zeta',
        name: 'Zeta',
        auth: { oauth: { name: 'OAuth', loginLabel: 'Sign in' }, apiKey: { name: 'Key', login: true } },
      },
      { id: 'alpha', name: 'Alpha', auth: { apiKey: { name: 'Ambient key' } } },
    ],
    getProviderAuthStatus: (id) =>
      id === 'zeta' ? { configured: true, source: 'stored', label: 'credential store' } : { configured: false },
    getAvailableSnapshot: () => [
      { provider: 'zeta', id: 'model-a' },
      { provider: 'alpha', id: 'model-b' },
      { provider: 'missing', id: 'model-c' },
    ],
    hasConfiguredAuth: (id) => id !== 'alpha',
    isUsingOAuth: () => true,
    refresh: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
}

describe('provider auth', () => {
  it('sorts providers, reports only startable methods, refreshes without network, and lists usable models', async () => {
    const current = runtime();
    const load = vi.fn(async () => current);
    const auth = createProviderAuth({ runtime: load });
    expect(await auth.listProviders()).toEqual([
      { id: 'alpha', name: 'Alpha', methods: [] },
      {
        id: 'zeta',
        name: 'Zeta',
        methods: [
          { type: 'oauth', label: 'Sign in' },
          { type: 'api_key', label: 'Key' },
        ],
        authenticated: { type: 'oauth', source: 'credential store' },
      },
    ]);
    expect(current.refresh).toHaveBeenCalledWith({ allowNetwork: false });
    expect(await auth.listModels()).toEqual([
      { value: 'zeta/model-a', label: 'model-a', group: 'Zeta' },
      { value: 'missing/model-c', label: 'model-c', group: 'missing' },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('continues with a stale snapshot after refresh fails, and retries a failed runtime load', async () => {
    const current = runtime();
    current.refresh = vi.fn(async () => {
      throw new Error('offline');
    });
    const load = vi.fn().mockRejectedValueOnce(new Error('startup')).mockResolvedValue(current);
    const notice = vi.fn();
    const auth = createProviderAuth({ runtime: load, onNotice: notice });
    await expect(auth.listProviders()).rejects.toThrow('startup');
    expect((await auth.listProviders()).map((provider) => provider.id)).toEqual(['alpha', 'zeta']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenCalledWith('provider auth refresh failed: offline');
  });

  it('rejects unknown, unsupported, and concurrent logins, then preserves a completed result', async () => {
    const current = runtime();
    let complete!: () => void;
    current.login = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const notice = vi.fn();
    const auth = createProviderAuth({ runtime: async () => current, onNotice: notice });
    expect(await auth.startLogin('missing', 'oauth')).toMatchObject({ ok: false, code: 'unknown_provider' });
    expect(await auth.startLogin('alpha', 'oauth')).toMatchObject({ ok: false, code: 'unsupported_method' });
    const started = await auth.startLogin('zeta', 'oauth', true);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected login to start');
    expect(started.flow.remote).toBe(true);
    expect(await auth.startLogin('zeta', 'api_key')).toMatchObject({ ok: false, code: 'busy' });
    expect(auth.answerLogin('unknown', '1', 'value')).toBe('unknown_flow');
    expect(auth.answerLogin(started.flow.id, '1', 'value')).toBe('not_waiting');
    complete();
    await vi.waitFor(() => expect(auth.getLogin(started.flow.id)?.status).toBe('succeeded'));
    expect(notice).toHaveBeenCalledWith('signed in to Zeta (oauth)');
    const next = await auth.startLogin('zeta', 'api_key');
    expect(next.ok).toBe(true);
    expect(auth.getLogin(started.flow.id)).toBeUndefined();
    auth.close();
    if (next.ok) expect(auth.getLogin(next.flow.id)).toBeUndefined();
  });

  it('routes answers to a pending login and cancels it', async () => {
    const current = runtime();
    let pending!: Promise<string>;
    let interaction!: LoginInteraction;
    current.login = vi.fn(async (_providerId, _type, value) => {
      interaction = value;
      pending = value.prompt({ type: 'text', message: 'Code?' });
      await pending;
    });
    const auth = createProviderAuth({ runtime: async () => current });
    const started = await auth.startLogin('zeta', 'oauth');
    if (!started.ok) throw new Error('expected login to start');
    expect(auth.getLogin(started.flow.id)?.prompt).toMatchObject({ id: '1', message: 'Code?' });
    expect(auth.answerLogin(started.flow.id, 'wrong', 'answer')).toBe('not_waiting');
    expect(auth.answerLogin(started.flow.id, '1', 'answer')).toBe('answered');
    await expect(pending).resolves.toBe('answer');
    await vi.waitFor(() => expect(auth.getLogin(started.flow.id)?.status).toBe('succeeded'));
    expect(interaction.signal.aborted).toBe(false);
    expect(auth.cancelLogin('unknown')).toBeUndefined();
    expect(auth.cancelLogin(started.flow.id)?.status).toBe('succeeded');
  });

  it('reports login and logout failures, and signs out known providers', async () => {
    const current = runtime();
    current.login = vi.fn(async () => {
      throw new Error('denied');
    });
    current.logout = vi.fn().mockRejectedValueOnce('offline').mockResolvedValue(undefined);
    const notice = vi.fn();
    const auth = createProviderAuth({ runtime: async () => current, onNotice: notice });
    const started = await auth.startLogin('zeta', 'oauth');
    if (!started.ok) throw new Error('expected login to start');
    await vi.waitFor(() => expect(auth.getLogin(started.flow.id)).toMatchObject({ status: 'failed', error: 'denied' }));
    expect(await auth.logout('missing')).toMatchObject({ ok: false, code: 'unknown_provider' });
    expect(await auth.logout('zeta')).toEqual({ ok: false, code: 'runtime', error: 'offline' });
    expect(await auth.logout('zeta')).toEqual({ ok: true });
    expect(notice).toHaveBeenCalledWith('signed out of Zeta');
  });
});
