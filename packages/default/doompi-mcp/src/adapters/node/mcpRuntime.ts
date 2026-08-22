import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigSource, McpServerStateChange, McpToolInfo, SharedServices, TokenStore } from '@agimon-ai/mcp-proxy';
import mcpProxyPackage from '@agimon-ai/mcp-proxy/package.json' with { type: 'json' };
import type { McpConfigSource } from '../../types/mcpConfig.ts';
import type { CachedCatalog } from '../../types/mcpRuntime.ts';

export interface McpRuntimeOptions {
  /** Ordered config layers. Later layers override earlier ones. */
  configSources: McpConfigSource[];
  tokenStore?: TokenStore;
  onAuthorizationUrl?: (url: URL, serverName: string) => void;
  onServerStateChange?: (change: McpServerStateChange) => void;
}

export interface McpRuntimeHandle {
  generation: number;
  services: SharedServices;
  /** Resolves once the first connection pass settles. Never rejects. */
  connectionsSettled: Promise<void>;
}

interface DefinitionsCacheFile {
  oneMcpVersion?: string;
  servers?: Record<string, { serverName: string; tools?: McpToolInfo[] }>;
}

/**
 * Definitions cache path shared by Doom's synchronous warm reader and mcp-proxy.
 *
 * Generated staging paths are deliberately absent: projected source content must
 * invalidate a reused path, while identical portable content must survive a new
 * private staging directory. Stable source origins are carried inside each cache
 * key; format and merge behavior remain part of the ordered identity.
 */
export function definitionsCachePath(configSources: readonly McpConfigSource[]): string {
  if (configSources.length === 0) throw new Error('definitionsCachePath requires at least one config source');
  const digest = createHash('sha256')
    .update(
      JSON.stringify(
        configSources.map((source) => ({
          cacheKey: source.cacheKey,
          format: source.format,
          optional: source.optional ?? false,
          mergeStrategy: source.mergeStrategy ?? 'remote-priority',
        })),
      ),
    )
    .update('\0')
    .update(mcpProxyPackage.version)
    .digest('hex');
  return join(homedir(), '.mcp-proxy', `doompi-${digest}.definitions-cache.json`);
}

/**
 * Reads the catalog the previous run left behind.
 *
 * Synchronous on purpose: Pi has to be able to register these tools during
 * extension install, before it takes its first turn, and awaiting a file read
 * would let that turn start with an empty tool set. A miss is normal on a first
 * run and resolves to an empty catalog rather than an error.
 *
 * The file path is content-addressed from the current ordered layers, and its proxy
 * version is checked before any schema is registered. Servers filtered out of the
 * current configuration are also excluded later by `McpCatalog.seed`.
 */
export function readCachedCatalog(
  configSources: readonly McpConfigSource[],
  cachePathFor: (sources: readonly McpConfigSource[]) => string = definitionsCachePath,
): CachedCatalog {
  if (configSources.length === 0) return { servers: [] };
  try {
    const cachePath = cachePathFor(configSources);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<DefinitionsCacheFile>;
    if (cache.oneMcpVersion !== mcpProxyPackage.version) return { servers: [] };
    const servers = Object.values(cache.servers ?? {}).map((server) => ({
      name: server.serverName,
      tools: server.tools ?? [],
    }));
    return { servers };
  } catch {
    return { servers: [] };
  }
}

function toProxyConfigSource(source: McpConfigSource): ConfigSource {
  return {
    path: source.path,
    format: source.format,
    ...(source.optional === undefined ? {} : { optional: source.optional }),
    ...(source.mergeStrategy === undefined ? {} : { mergeStrategy: source.mergeStrategy }),
  };
}

/**
 * Owns the one live mcp-proxy container for this extension.
 *
 * Pi reloads extensions in process, so a connect that lands after a session restart
 * or a `/domains` switch would otherwise fold tools into a dead context. Every start
 * takes the next generation; anything an older generation produces is dropped and its
 * container disposed.
 */
export class McpRuntimeOwner {
  private generation = 0;
  private active: SharedServices | undefined;
  private unsubscribe: (() => void) | undefined;

  get currentGeneration(): number {
    return this.generation;
  }

  /** The live container, or undefined before the first start and after dispose. */
  getServices(): SharedServices | undefined {
    return this.active;
  }

  /**
   * Whether a container a caller captured earlier is still the live one.
   *
   * An async continuation that started under one container has to check this
   * before writing its result, or a `/domains` switch would fold stale tools into
   * the new session.
   */
  isCurrent(services: SharedServices | undefined): boolean {
    return services !== undefined && services === this.active;
  }

  /**
   * Starts a container for the current configuration, replacing any predecessor.
   *
   * Returns undefined when a newer generation started while this one was building,
   * which is the signal for the caller to abandon its half-finished work.
   */
  async start(options: McpRuntimeOptions): Promise<McpRuntimeHandle | undefined> {
    const generation = ++this.generation;
    // Retired before the replacement is built so two containers never hold the same
    // stdio children open at once.
    await this.retire();
    if (options.configSources.length === 0) return undefined;

    // The proxy container pulls in transports, OAuth, schema conversion, and
    // server implementations. Cached tool registration needs none of those, so
    // load the runtime only after session_start has yielded control to Pi.
    const { createProxyContainer } = await import('@agimon-ai/mcp-proxy');
    const cachePath = definitionsCachePath(options.configSources);
    const services = await createProxyContainer({
      configSources: options.configSources.map(toProxyConfigSource),
      definitionsCachePath: cachePath,
      // Never blocking: an unreachable server must not delay Pi's first prompt.
      startupMode: 'background',
      auth: { tokenStore: options.tokenStore, onAuthorizationUrl: options.onAuthorizationUrl },
    });

    if (generation !== this.generation) {
      await services.dispose().catch(() => undefined);
      return undefined;
    }

    this.active = services;
    const forward = options.onServerStateChange;
    if (forward) {
      this.unsubscribe = services.clientManager.onServerStateChange((change) => {
        if (generation === this.generation) forward(change);
      });
    }

    return { generation, services, connectionsSettled: services.connectionsSettled };
  }

  /** Tears the container down and invalidates every generation still in flight. */
  async dispose(): Promise<void> {
    ++this.generation;
    await this.retire();
  }

  private async retire(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const services = this.active;
    this.active = undefined;
    // A failed teardown must not leave the owner believing a dead container is live.
    if (services) await services.dispose().catch(() => undefined);
  }
}
