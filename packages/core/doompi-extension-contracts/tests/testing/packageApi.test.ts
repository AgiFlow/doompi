import { describe, expect, it } from 'vitest';
import type { DoomApi, DoomApiContext } from '../../src/schemas/packageApi.ts';
import { mountPackageApi } from '../../src/services/testing/packageApi.ts';

/** An API written the way a package writes one: routes relative to its mount. */
function demoApi(overrides: Partial<DoomApi> = {}): DoomApi {
  let seen: DoomApiContext | undefined;
  let closed = false;
  return {
    basePath: 'demo',
    start(context) {
      seen = context;
      return {
        fetch: (request) => {
          const { pathname } = new URL(request.url);
          if (pathname === '/items') {
            return Response.json({ sessionId: seen?.sessionId ?? null, scope: seen?.scope, closed });
          }
          if (pathname === '/notice') {
            seen?.onNotice('the registry is unreachable');
            return new Response(null, { status: 204 });
          }
          return new Response('not found', { status: 404 });
        },
        close: () => {
          closed = true;
        },
      };
    },
    ...overrides,
  };
}

describe('mounting a package API the way a host does', () => {
  it('strips its own mount before the package sees the path', async () => {
    const mounted = mountPackageApi(demoApi());

    const response = await mounted.fetch('/api/plugin/demo/items');

    // The package declared '/items'; the client asked for the full mount. Both
    // are right, and this is the translation that makes them agree.
    expect(mounted.mountPath).toBe('/api/plugin/demo');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: 'hub' });
  });

  it('answers 404 outside its mount, as the host does for an unclaimed prefix', async () => {
    const mounted = mountPackageApi(demoApi());

    const other = await mounted.fetch('/api/plugin/elsewhere/items');
    const bare = await mounted.fetch('/api/health');

    expect(other.status).toBe(404);
    expect(bare.status).toBe(404);
  });

  it('routes the mount root to the package root', async () => {
    const mounted = mountPackageApi({
      basePath: 'demo',
      start: () => ({
        fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
        close: () => undefined,
      }),
    });

    expect(await (await mounted.fetch('/api/plugin/demo')).json()).toEqual({ path: '/' });
  });

  it('hands a session-scoped API its session and cwd, and a hub-scoped one neither', async () => {
    const session = mountPackageApi(demoApi(), { scope: 'session', sessionId: 's1', cwd: '/repo' });
    const hub = mountPackageApi(demoApi(), { scope: 'hub' });

    expect(await (await session.fetch('/api/plugin/demo/items')).json()).toMatchObject({
      sessionId: 's1',
      scope: 'session',
    });
    // A hub-scoped API that reads sessionId anyway should see the same
    // undefined it would see in the real hub, not a helpful default.
    expect(await (await hub.fetch('/api/plugin/demo/items')).json()).toMatchObject({ sessionId: null });
  });

  it('collects what the API told its host', async () => {
    const mounted = mountPackageApi(demoApi());

    await mounted.fetch('/api/plugin/demo/notice');

    expect(mounted.notices).toEqual(['the registry is unreachable']);
  });

  it('closes the handler the way a host does when the session ends', async () => {
    const mounted = mountPackageApi(demoApi());

    mounted.close();

    expect(await (await mounted.fetch('/api/plugin/demo/items')).json()).toMatchObject({ closed: true });
  });

  it('carries the method and body through to the package', async () => {
    const mounted = mountPackageApi({
      basePath: 'demo',
      start: () => ({
        fetch: async (request) => Response.json({ method: request.method, body: await request.text() }),
        close: () => undefined,
      }),
    });

    const response = await mounted.fetch('/api/plugin/demo/items', { method: 'POST', body: 'payload' });

    expect(await response.json()).toEqual({ method: 'POST', body: 'payload' });
  });
});
