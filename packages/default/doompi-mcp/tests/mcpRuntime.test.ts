import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStateChange, SharedServices } from '@agimon-ai/mcp-proxy';
import mcpProxyPackage from '@agimon-ai/mcp-proxy/package.json' with { type: 'json' };
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { definitionsCachePath, McpRuntimeOwner, readCachedCatalog } from '../src/adapters/node/mcpRuntime.ts';
import type { McpConfigSource } from '../src/types/mcpConfig.ts';

const createProxyContainer = vi.fn();
const getDefaultCachePath = vi.fn((..._args: unknown[]) => '/cache/definitions.json');

function configSource(
  sourcePath: string,
  cacheKey = sourcePath,
  format: McpConfigSource['format'] = 'claude',
): McpConfigSource {
  return { path: sourcePath, format, cacheKey };
}

// Only the two entry points doom-mcp calls are stubbed; every other export stays
// real so a barrel change surfaces as a type error rather than a silent undefined.
vi.mock('@agimon-ai/mcp-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/mcp-proxy')>()),
  createProxyContainer: (...args: unknown[]) => createProxyContainer(...args),
}));

interface FakeContainer {
  services: SharedServices;
  dispose: ReturnType<typeof vi.fn>;
  emit: (change: McpServerStateChange) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeContainer(): FakeContainer {
  const listeners = new Set<(change: McpServerStateChange) => void>();
  const dispose = vi.fn().mockResolvedValue(undefined);
  const unsubscribe = vi.fn();
  const services = {
    clientManager: {
      onServerStateChange: (listener: (change: McpServerStateChange) => void) => {
        listeners.add(listener);
        return unsubscribe;
      },
    },
    connectionsSettled: Promise.resolve(),
    dispose,
  } as unknown as SharedServices;

  return {
    services,
    dispose,
    unsubscribe,
    emit: (change) => {
      for (const listener of listeners) listener(change);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createProxyContainer.mockImplementation(() => Promise.resolve(fakeContainer().services));
});

describe('McpRuntimeOwner', () => {
  it('never blocks startup on downstream connections', async () => {
    const owner = new McpRuntimeOwner();

    await owner.start({ configSources: [configSource('/repo/.mcp.json')] });

    expect(createProxyContainer).toHaveBeenCalledWith(expect.objectContaining({ startupMode: 'background' }));
  });

  it('passes the ordered layers through as one config', async () => {
    const owner = new McpRuntimeOwner();
    const sources = [
      configSource('/repo/.mcp.json'),
      configSource('/plugin/.mcp.json', '/plugin/.mcp.json', 'internal'),
    ];

    await owner.start({ configSources: sources });

    expect(createProxyContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        configSources: [
          { path: '/repo/.mcp.json', format: 'claude' },
          { path: '/plugin/.mcp.json', format: 'internal' },
        ],
        definitionsCachePath: definitionsCachePath(sources),
      }),
    );
  });

  it('does not build a container when no layer contributes servers', async () => {
    const owner = new McpRuntimeOwner();

    const handle = await owner.start({ configSources: [] });

    expect(handle).toBeUndefined();
    expect(createProxyContainer).not.toHaveBeenCalled();
  });

  it('hands the host token store and authorization handler to the proxy', async () => {
    const owner = new McpRuntimeOwner();
    const tokenStore = { read: vi.fn(), write: vi.fn(), clear: vi.fn() };
    const onAuthorizationUrl = vi.fn();

    await owner.start({
      configSources: [configSource('/repo/.mcp.json')],
      tokenStore,
      onAuthorizationUrl,
    });

    expect(createProxyContainer).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { tokenStore, onAuthorizationUrl } }),
    );
  });

  describe('server state stream', () => {
    it('forwards state changes to the host', async () => {
      const container = fakeContainer();
      createProxyContainer.mockResolvedValue(container.services);
      const onServerStateChange = vi.fn();
      const owner = new McpRuntimeOwner();

      await owner.start({
        configSources: [configSource('/repo/.mcp.json')],
        onServerStateChange,
      });
      container.emit({ serverName: 'pencil', state: 'connected' });

      expect(onServerStateChange).toHaveBeenCalledWith({ serverName: 'pencil', state: 'connected' });
    });

    it('releases the subscription on dispose', async () => {
      const container = fakeContainer();
      createProxyContainer.mockResolvedValue(container.services);
      const owner = new McpRuntimeOwner();
      await owner.start({
        configSources: [configSource('/repo/.mcp.json')],
        onServerStateChange: vi.fn(),
      });

      await owner.dispose();

      expect(container.unsubscribe).toHaveBeenCalled();
      expect(container.dispose).toHaveBeenCalled();
    });
  });

  describe('generation guard', () => {
    it('retires the previous container before building its replacement', async () => {
      const first = fakeContainer();
      const second = fakeContainer();
      createProxyContainer.mockResolvedValueOnce(first.services).mockResolvedValueOnce(second.services);
      const owner = new McpRuntimeOwner();

      await owner.start({ configSources: [configSource('/repo/.mcp.json')] });
      await owner.start({ configSources: [configSource('/repo/.mcp.json')] });

      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(second.dispose).not.toHaveBeenCalled();
    });

    // A `/domains` switch restarts the runtime while the previous connect is still in
    // flight. Its container must be thrown away rather than folded into the live session.
    it('discards a container whose generation was superseded while it was building', async () => {
      const stale = fakeContainer();
      const owner = new McpRuntimeOwner();
      let releaseStale: (() => void) | undefined;
      createProxyContainer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStale = () => resolve(stale.services);
          }),
      );
      const fresh = fakeContainer();
      createProxyContainer.mockImplementationOnce(() => Promise.resolve(fresh.services));

      const pending = owner.start({ configSources: [configSource('/repo/.mcp.json')] });
      // Runtime loading is deliberately deferred now, so wait until the stale
      // build has actually claimed the first mocked container implementation.
      await vi.waitFor(() => expect(releaseStale).toBeTypeOf('function'));
      await owner.start({ configSources: [configSource('/repo/other.json')] });
      releaseStale?.();

      expect(await pending).toBeUndefined();
      expect(stale.dispose).toHaveBeenCalled();
    });

    it('does not forward state changes from a superseded container', async () => {
      const stale = fakeContainer();
      createProxyContainer.mockResolvedValue(stale.services);
      const onServerStateChange = vi.fn();
      const owner = new McpRuntimeOwner();
      await owner.start({
        configSources: [configSource('/repo/.mcp.json')],
        onServerStateChange,
      });

      await owner.start({ configSources: [configSource('/repo/other.json')] });
      stale.emit({ serverName: 'pencil', state: 'connected' });

      expect(onServerStateChange).not.toHaveBeenCalled();
    });

    it('invalidates every generation still in flight when disposed', async () => {
      const owner = new McpRuntimeOwner();
      const before = owner.currentGeneration;

      await owner.dispose();

      expect(owner.currentGeneration).toBeGreaterThan(before);
    });

    it('keeps the owner usable when a container fails to tear down', async () => {
      const failing = fakeContainer();
      failing.dispose.mockRejectedValue(new Error('teardown exploded'));
      const replacement = fakeContainer();
      createProxyContainer.mockResolvedValueOnce(failing.services).mockResolvedValueOnce(replacement.services);
      const owner = new McpRuntimeOwner();
      await owner.start({ configSources: [configSource('/repo/.mcp.json')] });

      await expect(owner.start({ configSources: [configSource('/repo/.mcp.json')] })).resolves.toBeDefined();
    });
  });
});

describe('readCachedCatalog', () => {
  let cacheDirectory: string;
  let cachePath: string;

  beforeEach(() => {
    cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-cache-'));
    cachePath = path.join(cacheDirectory, 'definitions.json');
    getDefaultCachePath.mockReturnValue(cachePath);
  });

  afterEach(() => {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  });

  function writeCache(contents: unknown): void {
    fs.writeFileSync(
      cachePath,
      typeof contents === 'string'
        ? contents
        : JSON.stringify({ oneMcpVersion: mcpProxyPackage.version, ...(contents as Record<string, unknown>) }),
    );
  }

  it('exposes the previous run tools without connecting to anything', () => {
    writeCache({ servers: { pencil: { serverName: 'pencil', tools: [{ name: 'get_screenshot', inputSchema: {} }] } } });

    const catalog = readCachedCatalog([configSource('/repo/.mcp.json')], getDefaultCachePath);

    expect(catalog.servers).toEqual([{ name: 'pencil', tools: [{ name: 'get_screenshot', inputSchema: {} }] }]);
    expect(createProxyContainer).not.toHaveBeenCalled();
  });

  it('keys the cache on the whole ordered layer list', () => {
    writeCache({ servers: {} });

    const sources = [configSource('/repo/.mcp.json'), configSource('/plugin/.mcp.json')];
    readCachedCatalog(sources, getDefaultCachePath);

    expect(getDefaultCachePath).toHaveBeenCalledWith(sources);
  });

  it('changes cache identity when the content key changes at the same native path', () => {
    const original = configSource('/repo/.mcp.json', 'native:repository:old-digest');
    const changed = configSource('/repo/.mcp.json', 'native:repository:new-digest');
    writeCache({
      servers: {
        pencil: {
          serverName: 'pencil',
          tools: [{ name: 'draw', inputSchema: { properties: { oldShape: { type: 'string' } } } }],
        },
      },
    });
    const originalCacheIdentity = definitionsCachePath([original]);
    const cachePathFor = (sources: readonly McpConfigSource[]) =>
      definitionsCachePath(sources) === originalCacheIdentity
        ? cachePath
        : path.join(cacheDirectory, 'new-content-has-no-cache.json');

    expect(definitionsCachePath([changed])).not.toBe(definitionsCachePath([original]));
    expect(readCachedCatalog([changed], cachePathFor)).toEqual({ servers: [] });
  });

  it('treats a first run with no cache as an empty catalog', () => {
    expect(readCachedCatalog([configSource('/repo/.mcp.json')], getDefaultCachePath)).toEqual({ servers: [] });
  });

  it('survives a cache file that is not valid JSON', () => {
    writeCache('not json');

    expect(readCachedCatalog([configSource('/repo/.mcp.json')], getDefaultCachePath)).toEqual({ servers: [] });
  });

  it('survives a cache file with no servers block', () => {
    writeCache({ version: 1 });

    expect(readCachedCatalog([configSource('/repo/.mcp.json')], getDefaultCachePath)).toEqual({ servers: [] });
  });

  it('rejects a definitions cache produced by another mcp-proxy version', () => {
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        oneMcpVersion: '0.0.0-stale',
        servers: { pencil: { serverName: 'pencil', tools: [{ name: 'stale_schema' }] } },
      }),
    );

    expect(readCachedCatalog([configSource('/repo/.mcp.json')], getDefaultCachePath)).toEqual({ servers: [] });
  });

  it('reads nothing when there are no config layers', () => {
    expect(readCachedCatalog([], getDefaultCachePath)).toEqual({ servers: [] });
    expect(getDefaultCachePath).not.toHaveBeenCalled();
  });
});
