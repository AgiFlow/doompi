import { describe, expect, it, vi } from 'vitest';

import { apiResponse, type ApiTransport, createApiClient, defineApiRoutes } from '../../src/web/services/apiClient';

interface Detail {
  readonly path: string;
}

const ROUTES = defineApiRoutes({
  detail: { method: 'GET', path: '/detail', query: ['path'], response: apiResponse<Detail>() },
  save: { method: 'PUT', path: '/content', response: apiResponse<{ hash: string }>() },
  remove: { method: 'DELETE', path: '/content', query: ['path'] },
  logStream: { method: 'GET', path: '/log/stream', stream: true },
  named: { method: 'PUT', path: '/prompts/:name' },
  file: { method: 'GET', path: '/file', query: ['path'], host: true },
});

const SESSION_ADDRESS = (sessionId: string) => ({ scope: 'session', workspaceId: 'ws-1', sessionId }) as const;

function clientWith(transport: ApiTransport) {
  return createApiClient(ROUTES, {
    scopes: ['session'],
    basePath: 'file-edits',
    transport,
    sessionAddress: SESSION_ADDRESS,
  });
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('url construction', () => {
  const api = clientWith(() => Promise.resolve(new Response(null, { status: 204 })));

  it('builds the mounted URL for a plugin route', () => {
    expect(api.session('s-1').detail.url({ query: { path: 'a.ts' } })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/file-edits/detail?path=a.ts',
    );
  });

  it('drops the base path for a host-owned route', () => {
    expect(api.session('s-1').file.url({ query: { path: 'a b.png' } })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/file?path=a%20b.png',
    );
  });

  it('gives a streaming route a URL and no way to call it', () => {
    expect(api.session('s-1').logStream.url()).toBe('/api/workspaces/ws-1/sessions/s-1/plugins/file-edits/log/stream');
    expect(typeof (api.session('s-1').logStream as unknown)).toBe('object');
  });
});

describe('scope accessors', () => {
  it('exposes only the scopes the package mounts at', () => {
    const api = clientWith(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(Object.keys(api)).toEqual(['session']);
  });

  it('exposes each mounted scope when a package serves several', () => {
    const api = createApiClient(ROUTES, {
      scopes: ['global', 'workspace'],
      basePath: 'log',
      transport: () => Promise.resolve(new Response(null, { status: 204 })),
      sessionAddress: SESSION_ADDRESS,
    });
    expect(Object.keys(api).sort()).toEqual(['global', 'workspace']);
    expect(api.workspace('ws-9').detail.url()).toBe('/api/workspaces/ws-9/plugins/log/detail');
  });
});

describe('calling a route', () => {
  it('returns the parsed body, the status and the response on success', async () => {
    const api = clientWith(() => Promise.resolve(json(200, { path: '/tmp/a.ts' })));
    const result = await api.session('s-1').detail({ query: { path: 'a.ts' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.path).toBe('/tmp/a.ts');
    expect(result.status).toBe(200);
    expect(result.response.status).toBe(200);
  });

  it('sends the method and the URL the route declares', async () => {
    const transport = vi.fn<ApiTransport>(() => Promise.resolve(new Response(null, { status: 204 })));
    await clientWith(transport)
      .session('s-1')
      .remove({ query: { path: 'a.ts' } });
    expect(transport).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/sessions/s-1/plugins/file-edits/content?path=a.ts',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('JSON-encodes an object body and declares its content type', async () => {
    const transport = vi.fn<ApiTransport>(() => Promise.resolve(json(200, { hash: 'x' })));
    await clientWith(transport)
      .session('s-1')
      .save({ body: { path: 'a.ts', content: 'hi' } });
    const init = transport.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"path":"a.ts","content":"hi"}');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('passes a Blob through untouched, because the relay carries bytes', async () => {
    const transport = vi.fn<ApiTransport>(() => Promise.resolve(new Response(null, { status: 204 })));
    const body = new Blob([new Uint8Array([1, 2, 3])]);
    await clientWith(transport).session('s-1').save({ body });
    const init = transport.mock.calls[0]?.[1];
    expect(init?.body).toBe(body);
    expect(init?.headers).toBeUndefined();
  });

  it('reports a refusal with its status and the message the route sent', async () => {
    const api = clientWith(() => Promise.resolve(json(409, { error: 'The file changed.', hash: 'abc' })));
    const result = await api.session('s-1').save({ body: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toBe('The file changed.');
    expect((result.data as { hash: string }).hash).toBe('abc');
  });

  it('reports an empty message rather than inventing one', async () => {
    const api = clientWith(() => Promise.resolve(new Response('', { status: 500 })));
    const result = await api.session('s-1').detail();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('');
    expect(result.data).toBeUndefined();
  });

  it('survives a non-JSON error body', async () => {
    const api = clientWith(() => Promise.resolve(new Response('<html>502</html>', { status: 502 })));
    const result = await api.session('s-1').detail();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.data).toBeUndefined();
  });

  it('reports status 0 only when the transport never answered', async () => {
    const api = clientWith(() => Promise.reject(new Error('offline')));
    const result = await api.session('s-1').detail();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(0);
    expect(result.response).toBeUndefined();
  });

  it('treats a 204 as success with no body', async () => {
    const api = clientWith(() => Promise.resolve(new Response(null, { status: 204 })));
    const result = await api.session('s-1').remove({ query: { path: 'a.ts' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(204);
    expect(result.data).toBeUndefined();
  });

  it('hands back response headers, which carry protocol state on several routes', async () => {
    const api = clientWith(() =>
      Promise.resolve(new Response(null, { status: 204, headers: { 'x-playback-state': 'sealed' } })),
    );
    const result = await api.session('s-1').remove();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.headers.get('x-playback-state')).toBe('sealed');
  });

  it('calls the same URL it reports from url()', async () => {
    const transport = vi.fn<ApiTransport>(() => Promise.resolve(json(200, {})));
    const scoped = clientWith(transport).session('s-1');
    const input = { query: { path: 'a b.ts' } };
    await scoped.detail(input);
    expect(transport.mock.calls[0]?.[0]).toBe(scoped.detail.url(input));
  });
});

describe('session ownership', () => {
  it('refuses to address a session whose workspace is unknown', () => {
    const api = createApiClient(ROUTES, {
      scopes: ['session'],
      basePath: 'file-edits',
      transport: () => Promise.resolve(new Response(null, { status: 204 })),
      sessionAddress: () => {
        throw new Error("Workspace is unavailable for session 's-1'.");
      },
    });
    expect(() => api.session('s-1')).toThrow('Workspace is unavailable');
  });
});

describe('cancellation', () => {
  it('forwards an abort signal, which loopback honours', async () => {
    const transport = vi.fn<ApiTransport>(() => Promise.resolve(json(200, {})));
    const controller = new AbortController();
    await clientWith(transport).session('s-1').detail({ signal: controller.signal });
    expect(transport.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('reports an aborted call as unanswered, so a caller can tell it apart', async () => {
    const api = clientWith(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const result = await api.session('s-1').detail();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(0);
  });
});

describe('path parameters through the client', () => {
  it('substitutes a named segment on the URL it reports', () => {
    const api = clientWith(() => Promise.resolve(new Response(null, { status: 204 })));
    expect(api.session('s-1').named.url({ params: { name: 'a b' } })).toBe(
      '/api/workspaces/ws-1/sessions/s-1/plugins/file-edits/prompts/a%20b',
    );
  });

  it('substitutes it on the URL it actually calls, which is a separate path through the code', async () => {
    const transport = vi.fn<ApiTransport>(() => Promise.resolve(new Response(null, { status: 204 })));
    await clientWith(transport)
      .session('s-1')
      .named({ params: { name: 'review' }, body: { text: 'x' } });
    expect(transport.mock.calls[0]?.[0]).toBe('/api/workspaces/ws-1/sessions/s-1/plugins/file-edits/prompts/review');
  });
});
