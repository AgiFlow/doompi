import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/web/lib/hubApi.ts';

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSession', () => {
  it('posts the request and returns the new session id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(201, { sessionId: 'fresh' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSession({ cwd: '/workspace/x', name: 'x' })).resolves.toEqual({ sessionId: 'fresh' });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/workspace/x', name: 'x' }),
    });
  });

  it('relays the hub error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(400, { error: 'A cwd string is required.' })));
    await expect(createSession({ cwd: '' })).resolves.toEqual({ error: 'A cwd string is required.' });
  });

  it('falls back to the status code when the body is not helpful', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
    await expect(createSession({ cwd: '/x' })).resolves.toEqual({ error: 'The hub answered 502.' });
  });

  it('reports an unreachable hub instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(createSession({ cwd: '/x' })).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});
