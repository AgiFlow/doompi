import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, restartSession, searchDirectories } from '../../src/web/lib/hubApi.ts';

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

describe('restartSession', () => {
  it('posts to the session’s restart route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, { sessionId: 'live' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(restartSession('live')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/live/restart', { method: 'POST' });
  });

  it('escapes an id that would otherwise change the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, {}));
    vi.stubGlobal('fetch', fetchMock);

    await restartSession('a/../b');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/a%2F..%2Fb/restart', { method: 'POST' });
  });

  it('relays the hub error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(502, { error: 'The session did not stop in time.' })));
    await expect(restartSession('live')).resolves.toEqual({ error: 'The session did not stop in time.' });
  });

  it('reports an unreachable hub instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(restartSession('live')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});

describe('searchDirectories', () => {
  it('asks the hub for the typed path and keeps only string entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { directories: ['/work/app', 7, '/work/lib'] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchDirectories('/work/^')).resolves.toEqual(['/work/app', '/work/lib']);
    expect(fetchMock).toHaveBeenCalledWith('/api/directories?q=%2Fwork%2F%5E');
  });

  it('shows nothing when the hub declines or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(searchDirectories('/x')).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(searchDirectories('/x')).resolves.toEqual([]);
  });
});
