import { describe, expect, it, vi } from 'vitest';
import type { DoomHubChannelHost } from '../../src/schemas/hubChannel.ts';
import type { DoomApi, DoomApiContext } from '../../src/schemas/packageApi.ts';
import {
  DoomServerFacetManifestError,
  declaredServerFacetsOf,
  isDoomServerFacet,
  orderServerFacets,
} from '../../src/schemas/serverFacet.ts';
import { createDoomServerHost } from '../../src/services/serverFacet.ts';

function contextWith(onNotice: (message: string) => void): DoomApiContext {
  return { scope: 'session', sessionId: 'session-1', cwd: '/repo', onNotice };
}

function apiNamed(basePath: string, close = vi.fn()): DoomApi {
  return {
    basePath,
    start: () => ({ fetch: () => new Response(basePath), close }),
  };
}

function channelHost(): DoomHubChannelHost {
  return {
    sessions: () => [],
    directEvents: {
      publish: () => undefined,
      subscribe: () => () => undefined,
      close: () => undefined,
    },
    publish: () => undefined,
    requestSessionApi: async () => new Response(null, { status: 204 }),
    onNotice: () => undefined,
  };
}
describe('createDoomServerHost', () => {
  it('mounts an api and hands its handler to the router', async () => {
    const host = createDoomServerHost({ scope: 'session', context: contextWith(vi.fn()) });

    expect(host.registerApi(apiNamed('runner')).mounted).toBe(true);

    expect(host.mounted()).toEqual(['runner']);
    const response = await host.handlerFor('runner')?.fetch(new Request('http://host/log'));
    expect(await response?.text()).toBe('runner');
  });

  it('reports the mount table on every change', () => {
    const onChange = vi.fn();
    const host = createDoomServerHost({ scope: 'session', context: contextWith(vi.fn()), onChange });

    const registration = host.registerApi(apiNamed('runner'));
    registration.dispose();

    expect(onChange.mock.calls).toEqual([[['runner']], [[]]]);
  });

  it('refuses a base path another facet already claims', () => {
    const notices: string[] = [];
    const host = createDoomServerHost({ scope: 'session', context: contextWith((m) => notices.push(m)) });

    host.registerApi(apiNamed('runner'));
    expect(host.registerApi(apiNamed('runner')).mounted).toBe(false);

    expect(host.mounted()).toEqual(['runner']);
    expect(notices).toEqual(["package API 'runner' is skipped: another facet already claims it."]);
  });

  it('skips an api whose start throws and keeps the rest mounted', () => {
    const notices: string[] = [];
    const host = createDoomServerHost({ scope: 'session', context: contextWith((m) => notices.push(m)) });

    expect(
      host.registerApi({
        basePath: 'broken',
        start: () => {
          throw new Error('no socket');
        },
      }).mounted,
    ).toBe(false);
    expect(host.registerApi(apiNamed('runner')).mounted).toBe(true);

    expect(host.mounted()).toEqual(['runner']);
    expect(notices[0]).toContain("package API 'broken' did not start");
  });

  it('closes a handler once, however often the registration is disposed', () => {
    const close = vi.fn();
    const host = createDoomServerHost({ scope: 'session', context: contextWith(vi.fn()) });

    const registration = host.registerApi(apiNamed('runner', close));
    registration.dispose();
    registration.dispose();

    expect(close).toHaveBeenCalledTimes(1);
    expect(host.handlerFor('runner')).toBeUndefined();
  });

  it('closes every handler on dispose and refuses later registrations', () => {
    const first = vi.fn();
    const second = vi.fn();
    const notices: string[] = [];
    const host = createDoomServerHost({ scope: 'session', context: contextWith((m) => notices.push(m)) });
    host.registerApi(apiNamed('runner', first));
    host.registerApi(apiNamed('voice-media', second));

    host.dispose();
    host.dispose();
    host.registerApi(apiNamed('git'));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(host.mounted()).toEqual([]);
    expect(notices).toEqual(["package API 'git' is skipped: the server host is already disposed."]);
  });

  it('reports a handler that does not close cleanly rather than throwing', () => {
    const notices: string[] = [];
    const host = createDoomServerHost({ scope: 'session', context: contextWith((m) => notices.push(m)) });
    host.registerApi(
      apiNamed(
        'runner',
        vi.fn(() => {
          throw new Error('busy');
        }),
      ),
    );

    expect(() => host.dispose()).not.toThrow();
    expect(notices[0]).toContain("package API 'runner' did not close cleanly");
  });

  it('owns channel sources and rejects duplicate frame types', () => {
    const notices: string[] = [];
    const close = vi.fn();
    const host = createDoomServerHost({
      scope: 'hub',
      context: { scope: 'hub', cwd: '/repo', onNotice: (message) => notices.push(message) },
      channelHost: channelHost(),
    });
    const channel = { frameType: 'tasks', start: () => ({ payloadFor: () => undefined, close }) };

    expect(host.registerChannel(channel).mounted).toBe(true);
    expect(host.registerChannel(channel).mounted).toBe(false);
    expect(host.mountedChannels()).toEqual(['tasks']);

    host.dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(notices).toEqual(["hub channel 'tasks' is skipped: another facet already claims it."]);
  });
});
describe('declaredServerFacetsOf', () => {
  const manifest = (doompiServer: unknown): Record<string, unknown> => ({ name: '@scope/pkg', doompiServer });

  it('returns nothing when a package declares no facet', () => {
    expect(declaredServerFacetsOf('/pkg', { name: '@scope/pkg' })).toEqual([]);
  });

  it('defaults to both scopes', () => {
    expect(
      declaredServerFacetsOf('/pkg', manifest({ entry: './src/extensions/server.ts', dist: './dist/server.mjs' })),
    ).toEqual([
      {
        packageName: '@scope/pkg',
        packageDir: '/pkg',
        entry: './src/extensions/server.ts',
        dist: './dist/server.mjs',
        scopes: ['session', 'hub'],
      },
    ]);
  });

  it('keeps a declared scope list and drops repeats', () => {
    const [facet] = declaredServerFacetsOf(
      '/pkg',
      manifest({ entry: './src/e.ts', dist: './dist/e.mjs', scopes: ['hub', 'hub'] }),
    );
    expect(facet?.scopes).toEqual(['hub']);
  });

  it('falls back to the directory when the manifest has no name', () => {
    const [facet] = declaredServerFacetsOf('/pkg', { doompiServer: { entry: './src/e.ts', dist: './dist/e.mjs' } });
    expect(facet?.packageName).toBe('/pkg');
  });

  it.each([
    ['a non-object block', 'nope', 'the block must be an object'],
    ['a missing entry', { dist: './dist/e.mjs' }, 'entry must be a package-relative'],
    [
      'an escaping entry',
      { entry: './../e.ts', dist: './dist/e.mjs' },
      "entry must be a package-relative ./path with no '..'",
    ],
    ['a missing dist', { entry: './src/e.ts' }, 'dist is required'],
    ['a bare dist', { entry: './src/e.ts', dist: 'dist/e.mjs' }, 'dist must be a package-relative'],
    [
      'an empty scope list',
      { entry: './src/e.ts', dist: './dist/e.mjs', scopes: [] },
      'scopes must be a non-empty array',
    ],
    ['an unknown scope', { entry: './src/e.ts', dist: './dist/e.mjs', scopes: ['tui'] }, "scope 'tui' must be"],
  ])('rejects %s', (_name, block, message) => {
    expect(() => declaredServerFacetsOf('/pkg', manifest(block))).toThrow(DoomServerFacetManifestError);
    expect(() => declaredServerFacetsOf('/pkg', manifest(block))).toThrow(message as string);
  });
});

describe('orderServerFacets', () => {
  const facet = (packageName: string, packageDir: string): ReturnType<typeof declaredServerFacetsOf>[number] => ({
    packageName,
    packageDir,
    entry: './src/e.ts',
    dist: './dist/e.mjs',
    scopes: ['session'],
  });

  it('orders by package name', () => {
    const ordered = orderServerFacets([facet('@scope/b', '/b'), facet('@scope/a', '/a')]);
    expect(ordered.map((entry) => entry.packageName)).toEqual(['@scope/a', '@scope/b']);
  });

  it('keeps the first directory claiming a package name', () => {
    const notices: string[] = [];
    const ordered = orderServerFacets([facet('@scope/a', '/second'), facet('@scope/a', '/first')], (m) =>
      notices.push(m),
    );

    expect(ordered.map((entry) => entry.packageDir)).toEqual(['/first']);
    expect(notices).toEqual(["server facet '@scope/a' from /second is skipped: /first already claims it."]);
  });
});

describe('isDoomServerFacet', () => {
  it('accepts an object plugin and rejects anything else', () => {
    expect(isDoomServerFacet({ apply: () => undefined })).toBe(true);
    expect(isDoomServerFacet({ inject: ['doom/server-host'], apply: () => undefined })).toBe(true);
    // A bare function is a valid cordis plugin but cannot declare its own
    // inject, so a host could not await it as one fiber.
    expect(isDoomServerFacet(() => undefined)).toBe(false);
    expect(isDoomServerFacet({})).toBe(false);
    expect(isDoomServerFacet(undefined)).toBe(false);
  });
});
