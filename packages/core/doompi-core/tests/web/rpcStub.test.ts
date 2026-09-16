import { describe, expect, it } from 'vitest';

import { apiResponse, createApiClient, defineApiRoutes } from '../../src/web/services/apiClient';
import { createRpcStub } from '../../src/web/services/testing/rpcStub';

const ROUTES = defineApiRoutes({
  detail: { method: 'GET', path: '/detail', query: ['path'], response: apiResponse<{ path: string }>() },
  preview: { method: 'GET', path: '/preview', query: ['path'], response: apiResponse<{ path: string }>() },
  remove: { method: 'DELETE', path: '/content', query: ['path'] },
  file: { method: 'GET', path: '/file', query: ['path'], host: true },
});

function clientWith(stub: ReturnType<typeof createRpcStub>) {
  return createApiClient(ROUTES, {
    scopes: ['session'],
    basePath: 'file-edits',
    transport: stub.transport,
    sessionAddress: (sessionId) => ({ scope: 'session', workspaceId: 'ws-1', sessionId }),
  });
}

describe('the rpc stub', () => {
  it('answers the route its matcher names', async () => {
    const stub = createRpcStub();
    const api = clientWith(stub);
    stub.on(api.session('s-1').detail, () => ({ path: '/tmp/a.ts' }));

    const result = await api.session('s-1').detail({ query: { path: 'a.ts' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.path).toBe('/tmp/a.ts');
  });

  it('matches whatever query the caller sends, since the route is the identity', async () => {
    const stub = createRpcStub();
    const api = clientWith(stub);
    stub.on(api.session('s-1').detail, (request) => ({ path: request.url.searchParams.get('path') ?? '' }));

    const result = await api.session('s-1').detail({ query: { path: 'deep/nested file.ts' } });
    expect(result.ok && result.data.path).toBe('deep/nested file.ts');
  });

  /**
   * The failure this exists to prevent. Two routes of one package, one fixture
   * registered: the unregistered one must fail loudly rather than be answered
   * by the other matcher.
   */
  it('refuses a request nothing matched instead of serving a neighbour', async () => {
    const stub = createRpcStub();
    const api = clientWith(stub);
    stub.on(api.session('s-1').file, () => new Response('bytes'));

    const result = await api.session('s-1').preview({ query: { path: 'a.ts' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not a 0, which would read as an unreachable session, and not the bytes
    // the neighbouring matcher would have served.
    expect(result.status).toBe(599);
    expect(result.error).toMatch(
      /No stub answers GET \/api\/workspaces\/ws-1\/sessions\/s-1\/plugins\/file-edits\/preview/u,
    );
    expect(() => stub.assertNoMisses()).toThrow(/routes it does not answer/u);
  });

  it('separates two routes that share a path and differ only by method', async () => {
    const stub = createRpcStub();
    const api = clientWith(stub);
    stub.on(api.session('s-1').remove, () => new Response(null, { status: 204 }));

    const removed = await api.session('s-1').remove({ query: { path: 'a.ts' } });
    expect(removed.status).toBe(204);
  });

  it('names what is registered when nothing matches, so the fix is obvious', async () => {
    const stub = createRpcStub();
    const api = clientWith(stub);
    const result = await api.session('s-1').detail();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Registered: \(none\)/u);
  });

  it('records every request it carried', async () => {
    const stub = createRpcStub();
    const api = clientWith(stub);
    stub.on(api.session('s-1').detail, () => ({ path: 'a' }));
    await api.session('s-1').detail({ query: { path: 'a.ts' } });
    expect(stub.calls).toEqual([
      { method: 'GET', url: '/api/workspaces/ws-1/sessions/s-1/plugins/file-edits/detail?path=a.ts' },
    ]);
    expect(() => stub.assertNoMisses()).not.toThrow();
  });
});
