import { beforeEach, describe, expect, it, vi } from 'vitest';
import { machineApi } from '../../../../../src/server/machineApi';

const auth = vi.hoisted(() => ({
  listProviders: vi.fn(),
  listModels: vi.fn(),
  logout: vi.fn(),
  startLogin: vi.fn(),
  getLogin: vi.fn(),
  answerLogin: vi.fn(),
  cancelLogin: vi.fn(),
  close: vi.fn(),
}));

vi.mock('../../../../../src/services/providerAuth', () => ({ createProviderAuth: () => auth }));

const context = { scope: 'global' as const, onNotice: vi.fn() };

async function response(handler: ReturnType<typeof machineApi.start>, path: string, method = 'GET', body?: unknown) {
  const result = await handler.fetch(
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: result.status, body: await result.json() };
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.listProviders.mockResolvedValue([{ id: 'test' }]);
  auth.listModels.mockResolvedValue([{ value: 'test/model' }]);
  auth.logout.mockResolvedValue({ ok: true });
  auth.startLogin.mockResolvedValue({ ok: true, flow: { id: 'flow' } });
  auth.getLogin.mockReturnValue({ id: 'flow', status: 'running' });
  auth.answerLogin.mockReturnValue('answered');
  auth.cancelLogin.mockReturnValue({ id: 'flow', status: 'cancelled' });
});

describe('machineApi', () => {
  it('requires a global mount and closes the provider service', async () => {
    expect(() => machineApi.start({ ...context, scope: 'session' })).toThrow('global mount');
    const handler = machineApi.start(context);
    expect(await response(handler, '/providers')).toEqual({ status: 200, body: { providers: [{ id: 'test' }] } });
    expect(await response(handler, '/models')).toEqual({ status: 200, body: { models: [{ value: 'test/model' }] } });
    handler.close();
    expect(auth.close).toHaveBeenCalledOnce();
    expect(await response(handler, '/providers')).toEqual({
      status: 503,
      body: { error: 'Provider mount is closed.' },
    });
    expect(auth.listProviders).toHaveBeenCalledOnce();
  });

  it('maps provider logout outcomes to HTTP statuses', async () => {
    const handler = machineApi.start(context);
    expect(await response(handler, '/providers/test%20provider', 'DELETE')).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(auth.logout).toHaveBeenCalledWith('test provider');
    auth.logout.mockResolvedValueOnce({ ok: false, code: 'unknown_provider', error: 'unknown' });
    expect(await response(handler, '/providers/missing', 'DELETE')).toEqual({
      status: 404,
      body: { error: 'unknown' },
    });
    auth.logout.mockResolvedValueOnce({ ok: false, code: 'runtime', error: 'failed' });
    expect(await response(handler, '/providers/test', 'DELETE')).toEqual({ status: 502, body: { error: 'failed' } });
    expect(await response(handler, '/providers/test', 'GET')).toEqual({
      status: 404,
      body: { error: 'Provider route not found.' },
    });
    handler.close();
  });

  it.each([null, [], {}, { providerId: 1, type: 'oauth' }, { providerId: 'test', type: 'password' }])(
    'rejects an invalid login body: %j',
    async (body) => {
      const handler = machineApi.start(context);
      expect(await response(handler, '/logins', 'POST', body)).toEqual({
        status: 400,
        body: { error: 'A provider and supported login method are required.' },
      });
      expect(auth.startLogin).not.toHaveBeenCalled();
      handler.close();
    },
  );

  it('starts logins and maps provider and concurrency failures', async () => {
    const handler = machineApi.start(context);
    expect(await response(handler, '/logins', 'POST', { providerId: 'test', type: 'oauth' })).toEqual({
      status: 201,
      body: { flow: { id: 'flow' } },
    });
    expect(auth.startLogin).toHaveBeenCalledWith('test', 'oauth');
    auth.startLogin.mockResolvedValueOnce({ ok: false, code: 'unknown_provider', error: 'missing' });
    expect(await response(handler, '/logins', 'POST', { providerId: 'bad', type: 'api_key' })).toEqual({
      status: 404,
      body: { error: 'missing' },
    });
    auth.startLogin.mockResolvedValueOnce({ ok: false, code: 'busy', error: 'busy' });
    expect(await response(handler, '/logins', 'POST', { providerId: 'test', type: 'oauth' })).toEqual({
      status: 409,
      body: { error: 'busy' },
    });
    auth.startLogin.mockResolvedValueOnce({ ok: false, code: 'unsupported_method', error: 'unsupported' });
    expect(await response(handler, '/logins', 'POST', { providerId: 'test', type: 'api_key' })).toEqual({
      status: 400,
      body: { error: 'unsupported' },
    });
    handler.close();
  });

  it('reads, answers, and cancels a flow only while it exists', async () => {
    const handler = machineApi.start(context);
    expect(await response(handler, '/logins/flow')).toEqual({
      status: 200,
      body: { flow: { id: 'flow', status: 'running' } },
    });
    expect(await response(handler, '/logins/flow/answer', 'POST', { promptId: 'prompt', value: 'secret' })).toEqual({
      status: 200,
      body: { flow: { id: 'flow', status: 'running' } },
    });
    expect(auth.answerLogin).toHaveBeenCalledWith('flow', 'prompt', 'secret');
    auth.answerLogin.mockReturnValueOnce('not_waiting');
    expect(await response(handler, '/logins/flow/answer', 'POST', { promptId: 'prompt', value: 'late' })).toEqual({
      status: 409,
      body: { error: 'Login is no longer waiting for this answer.' },
    });
    expect(await response(handler, '/logins/flow', 'DELETE')).toEqual({
      status: 200,
      body: { flow: { id: 'flow', status: 'cancelled' } },
    });
    auth.getLogin.mockReturnValueOnce(undefined);
    expect(await response(handler, '/logins/missing')).toEqual({
      status: 404,
      body: { error: 'Login flow not found.' },
    });
    handler.close();
  });

  it.each([null, [], {}, { promptId: 1, value: 'yes' }, { promptId: 'prompt', value: 1 }])(
    'rejects an invalid login answer: %j',
    async (body) => {
      const handler = machineApi.start(context);
      expect(await response(handler, '/logins/flow/answer', 'POST', body)).toEqual({
        status: 400,
        body: { error: 'A prompt ID and answer are required.' },
      });
      expect(auth.answerLogin).not.toHaveBeenCalled();
      handler.close();
    },
  );

  it('reports invalid JSON and provider failures without leaking exceptions', async () => {
    const handler = machineApi.start(context);
    const invalid = await handler.fetch(new Request('http://localhost/logins', { method: 'POST', body: '{' }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.any(String) });
    auth.listProviders.mockRejectedValueOnce(new Error('provider unavailable'));
    expect(await response(handler, '/providers')).toEqual({ status: 502, body: { error: 'provider unavailable' } });
    auth.listModels.mockRejectedValueOnce('runtime failed');
    expect(await response(handler, '/models')).toEqual({ status: 502, body: { error: 'runtime failed' } });
    expect(await response(handler, '/elsewhere')).toEqual({
      status: 404,
      body: { error: 'Provider route not found.' },
    });
    handler.close();
  });
});
