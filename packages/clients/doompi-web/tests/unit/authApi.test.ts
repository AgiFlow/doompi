import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerLogin,
  cancelLogin,
  listProviders,
  logoutProvider,
  readLogin,
  startLogin,
} from '../../src/web/lib/authApi.ts';

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const flow = {
  id: 'f1',
  providerId: 'anthropic',
  providerName: 'Anthropic',
  type: 'api_key',
  status: 'running',
  events: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('authApi', () => {
  it('lists providers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { providers: [{ id: 'anthropic' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listProviders()).resolves.toEqual({ providers: [{ id: 'anthropic' }] });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/providers', undefined);
  });

  it('posts a login start and reads the flow back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(201, { flow }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(startLogin('anthropic', 'api_key')).resolves.toEqual({ flow });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'anthropic', type: 'api_key' }),
    });
  });

  it('polls, answers, and cancels a flow by id', async () => {
    const fetchMock = vi.fn().mockImplementation(() => respond(200, { flow }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readLogin('f 1')).resolves.toEqual({ flow });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/logins/f%201', undefined);
    await expect(answerLogin('f1', '1', 'sk')).resolves.toEqual({ flow });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/logins/f1/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptId: '1', value: 'sk' }),
    });
    await expect(cancelLogin('f1')).resolves.toEqual({ flow });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/logins/f1', { method: 'DELETE' });
  });

  it('logs out a provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { providerId: 'anthropic' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(logoutProvider('anthropic')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/providers/anthropic', { method: 'DELETE' });
  });

  it('relays the hub error, falls back to the status, and reports an unreachable hub', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, { error: 'already in progress' })));
    await expect(startLogin('anthropic', 'oauth')).resolves.toEqual({ error: 'already in progress' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    await expect(listProviders()).resolves.toEqual({ error: 'The hub answered 502.' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { unexpected: true })));
    await expect(readLogin('f1')).resolves.toEqual({ error: 'The hub answered 200.' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refused')));
    await expect(logoutProvider('anthropic')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});
