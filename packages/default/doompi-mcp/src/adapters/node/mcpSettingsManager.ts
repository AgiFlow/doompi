import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSyncDrift } from '@agimon-ai/doompi/services';
import { readSyncState } from '@agimon-ai/doompi/services/syncState';
import type { McpServerStateChange, McpToolInfo, TokenStore } from '@agimon-ai/mcp-proxy';
import type {
  McpAuthorizationFlow,
  McpRepositoryCatalog,
  McpRepositoryServer,
  McpRepositoryServerState,
  McpRepositoryTool,
} from '../../types/webMcp.ts';
import type { McpConfigGroups, McpConfigSource, McpSessionConfig } from '../../types/mcpConfig.ts';
import { toPiToolName } from '../../services/mcpCatalog.ts';
import { buildMcpConfigGroups } from './configSources.ts';
import { createTokenStore } from './keyringTokenStore.ts';
import { McpRuntimeOwner, readCachedCatalog } from './mcpRuntime.ts';
import { mcpSessionConfigFromProjection } from './projection.ts';

const DISCOVERY_TIMEOUT_MS = 30_000;
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const TERMINAL_FLOW_RETENTION_MS = 5 * 60_000;
const EMPTY_SYNC = { fresh: false, reasons: ['never-synced'] } as const;

interface PreparedMcpRepository {
  catalog: McpRepositoryCatalog;
  configSources: McpConfigSource[];
  groups: McpConfigGroups;
  stagingDirectory?: string;
}

interface InternalAuthorizationFlow extends McpAuthorizationFlow {
  owner?: McpRuntimeOwner;
  stagingDirectory?: string;
  timeout?: ReturnType<typeof setTimeout>;
  retainedUntil?: number;
}

export interface McpSettingsManagerOptions {
  homeDirectory?: string;
  discoveryTimeoutMs?: number;
  authorizationTimeoutMs?: number;
  tokenStore?: TokenStore;
}

function configuredServerNames(groups: McpConfigGroups): string[] {
  return [...new Set([...groups.sessionLocal.serverNames, ...groups.shared.serverNames])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function configSources(groups: McpConfigGroups): McpConfigSource[] {
  return [...groups.sessionLocal.configSources, ...groups.shared.configSources];
}

function toolView(serverName: string, tool: McpToolInfo): McpRepositoryTool {
  return {
    name: tool.name,
    piName: toPiToolName(serverName, tool.name),
    ...(tool.description ? { description: tool.description } : {}),
  };
}

function sanitizeDiagnostic(message: string, repositoryRoot: string, stagingDirectory: string | undefined): string {
  let safe = message;
  for (const value of [stagingDirectory, repositoryRoot, os.homedir()]) {
    if (value) safe = safe.split(value).join(value === os.homedir() ? '~' : '<repository>');
  }
  return safe.replace(/[A-Za-z]:\\[^\s,;)'"`]+/gu, '<path>').replace(/(^|\s)\/(?!\/)[^\s,;)'"`]+/gu, '$1<path>');
}

function publicFlow(flow: InternalAuthorizationFlow): McpAuthorizationFlow {
  return {
    id: flow.id,
    repositoryId: flow.repositoryId,
    serverName: flow.serverName,
    status: flow.status,
    ...(flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : {}),
    ...(flow.error ? { error: flow.error } : {}),
    expiresAt: flow.expiresAt,
  };
}

function isTerminal(status: McpAuthorizationFlow['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

function safeAuthorizationUrl(url: URL): string | undefined {
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.toString().length > 4096) return undefined;
  return url.toString();
}

export class McpSettingsManager {
  private readonly homeDirectory: string;
  private readonly discoveryTimeoutMs: number;
  private readonly authorizationTimeoutMs: number;
  private readonly injectedTokenStore?: TokenStore;
  private readonly busyRepositories = new Set<string>();
  private readonly flows = new Map<string, InternalAuthorizationFlow>();

  constructor(options: McpSettingsManagerOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
    this.authorizationTimeoutMs = options.authorizationTimeoutMs ?? AUTHORIZATION_TIMEOUT_MS;
    this.injectedTokenStore = options.tokenStore;
  }

  private async tokenStore(): Promise<TokenStore> {
    return this.injectedTokenStore ?? (await createTokenStore());
  }

  private async credentialPresence(serverNames: readonly string[]): Promise<Map<string, boolean>> {
    const presence = new Map<string, boolean>();
    try {
      const tokenStore = await this.tokenStore();
      await Promise.all(
        serverNames.map(async (serverName) => {
          try {
            presence.set(serverName, (await tokenStore.read(serverName)) !== undefined);
          } catch {
            presence.set(serverName, false);
          }
        }),
      );
    } catch {
      for (const serverName of serverNames) presence.set(serverName, false);
    }
    return presence;
  }

  private prepare(repositoryId: string, repositoryRoot: string, onlyServer?: string): PreparedMcpRepository {
    const drift = readSyncDrift({ repoRoot: repositoryRoot, homeDirectory: this.homeDirectory });
    const state = readSyncState(repositoryRoot, this.homeDirectory);
    if (!state) {
      return {
        catalog: {
          repositoryId,
          sync: { ...EMPTY_SYNC, reasons: [...EMPTY_SYNC.reasons] },
          servers: [],
          droppedServers: [],
          diagnostics: [],
        },
        configSources: [],
        groups: {
          shared: { configSources: [], configPaths: [], serverNames: [] },
          sessionLocal: { configSources: [], configPaths: [], serverNames: [] },
          droppedServers: [],
          diagnostics: [],
        },
      };
    }

    const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-mcp-settings-'));
    fs.chmodSync(stagingDirectory, 0o700);
    try {
      const projected = mcpSessionConfigFromProjection(state.fileState.mcpProjection);
      const configuration: McpSessionConfig = {
        ...projected,
        repoRoot: repositoryRoot,
        stagingDirectory,
        ...(onlyServer ? { allowlist: { servers: [onlyServer], proxy: [] } } : {}),
      };
      const groups = buildMcpConfigGroups(configuration);
      const sources = configSources(groups);
      const names = configuredServerNames(groups);
      const cachedByServer = new Map(readCachedCatalog(sources).servers.map((server) => [server.name, server.tools]));
      const servers: McpRepositoryServer[] = names.map((name) => {
        const tools = cachedByServer.get(name) ?? [];
        return {
          name,
          state: 'not-connected',
          source: tools.length === 0 ? 'configured' : 'cached',
          credentialPresent: false,
          tools: tools.map((tool) => toolView(name, tool)),
        };
      });
      return {
        catalog: {
          repositoryId,
          sync: { fresh: drift.fresh, reasons: [...drift.reasons] },
          servers,
          droppedServers: [...groups.droppedServers],
          diagnostics: groups.diagnostics.map((diagnostic) =>
            sanitizeDiagnostic(diagnostic, repositoryRoot, stagingDirectory),
          ),
        },
        configSources: sources,
        groups,
        stagingDirectory,
      };
    } catch (error) {
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private cleanupPrepared(prepared: PreparedMcpRepository): void {
    if (prepared.stagingDirectory) fs.rmSync(prepared.stagingDirectory, { recursive: true, force: true });
  }

  async readCatalog(repositoryId: string, repositoryRoot: string): Promise<McpRepositoryCatalog> {
    const prepared = this.prepare(repositoryId, repositoryRoot);
    try {
      const presence = await this.credentialPresence(prepared.catalog.servers.map((server) => server.name));
      return {
        ...prepared.catalog,
        servers: prepared.catalog.servers.map((server) => ({
          ...server,
          credentialPresent: presence.get(server.name) ?? false,
        })),
      };
    } finally {
      this.cleanupPrepared(prepared);
    }
  }

  async discover(repositoryId: string, repositoryRoot: string): Promise<McpRepositoryCatalog> {
    if (this.busyRepositories.has(repositoryId))
      throw new Error('MCP management is already active for this repository.');
    const prepared = this.prepare(repositoryId, repositoryRoot);
    if (!prepared.catalog.sync.fresh) {
      this.cleanupPrepared(prepared);
      throw new Error('Sync this repository before discovering MCP capabilities.');
    }
    if (prepared.configSources.length === 0) {
      this.cleanupPrepared(prepared);
      return prepared.catalog;
    }

    this.busyRepositories.add(repositoryId);
    const owner = new McpRuntimeOwner();
    const liveStates = new Map<string, McpServerStateChange>();
    try {
      const handle = await owner.start({
        configSources: prepared.configSources,
        tokenStore: await this.tokenStore(),
        onAuthorizationUrl: (_url, serverName) => {
          liveStates.set(serverName, { serverName, state: 'needs-auth' });
        },
        onServerStateChange: (change) => liveStates.set(change.serverName, change),
      });
      if (handle) {
        await Promise.race([
          handle.connectionsSettled,
          new Promise<void>((resolve) => setTimeout(resolve, this.discoveryTimeoutMs)),
        ]);
      }
      const manager = handle?.services.clientManager;
      const cachedByServer = new Map(
        readCachedCatalog(prepared.configSources).servers.map((server) => [server.name, server.tools]),
      );
      const presence = await this.credentialPresence(prepared.catalog.servers.map((server) => server.name));
      const servers = await Promise.all(
        prepared.catalog.servers.map(async (server): Promise<McpRepositoryServer> => {
          const change = liveStates.get(server.name);
          const state = (change?.state ??
            manager?.getServerState(server.name) ??
            server.state) as McpRepositoryServerState;
          let tools = cachedByServer.get(server.name) ?? [];
          let source: McpRepositoryServer['source'] = tools.length === 0 ? 'configured' : 'cached';
          if (state === 'connected' && manager) {
            try {
              tools = await manager
                .ensureConnected(server.name)
                .then(async (connection) => await connection.listTools());
              source = 'live';
            } catch {
              // Preserve the cache when a server moved between state inspection and listing.
            }
          }
          return {
            name: server.name,
            state,
            source,
            credentialPresent: presence.get(server.name) ?? false,
            tools: tools.map((tool) => toolView(server.name, tool)),
            ...(change?.error ? { error: 'The server reported a connection error.' } : {}),
          };
        }),
      );
      return { ...prepared.catalog, servers };
    } finally {
      await owner.dispose();
      this.cleanupPrepared(prepared);
      this.busyRepositories.delete(repositoryId);
    }
  }

  async authorize(repositoryId: string, repositoryRoot: string, serverName: string): Promise<McpAuthorizationFlow> {
    this.sweepFlows();
    if (this.busyRepositories.has(repositoryId))
      throw new Error('MCP management is already active for this repository.');

    const full = this.prepare(repositoryId, repositoryRoot);
    const configured = full.catalog.servers.some((server) => server.name === serverName);
    const fresh = full.catalog.sync.fresh;
    this.cleanupPrepared(full);
    if (!fresh) throw new Error('Sync this repository before authorizing an MCP server.');
    if (!configured) throw new Error('That MCP server is not enabled for this repository.');

    const prepared = this.prepare(repositoryId, repositoryRoot, serverName);
    const flow: InternalAuthorizationFlow = {
      id: randomUUID(),
      repositoryId,
      serverName,
      status: 'starting',
      expiresAt: Date.now() + this.authorizationTimeoutMs,
      stagingDirectory: prepared.stagingDirectory,
    };
    this.flows.set(flow.id, flow);
    this.busyRepositories.add(repositoryId);
    void this.runAuthorization(flow, prepared.configSources);
    return publicFlow(flow);
  }

  getAuthorization(flowId: string, repositoryId: string): McpAuthorizationFlow | undefined {
    this.sweepFlows();
    const flow = this.flows.get(flowId);
    return flow?.repositoryId === repositoryId ? publicFlow(flow) : undefined;
  }

  async cancelAuthorization(flowId: string, repositoryId: string): Promise<McpAuthorizationFlow | undefined> {
    const flow = this.flows.get(flowId);
    if (!flow || flow.repositoryId !== repositoryId) return undefined;
    if (!isTerminal(flow.status)) {
      flow.status = 'cancelled';
      await this.finishFlow(flow);
    }
    return publicFlow(flow);
  }

  private async runAuthorization(flow: InternalAuthorizationFlow, sources: McpConfigSource[]): Promise<void> {
    const owner = new McpRuntimeOwner();
    flow.owner = owner;
    flow.timeout = setTimeout(() => {
      if (isTerminal(flow.status)) return;
      flow.status = 'expired';
      flow.error = 'Authorization timed out.';
      void this.finishFlow(flow);
    }, this.authorizationTimeoutMs);

    try {
      const handle = await owner.start({
        configSources: sources,
        tokenStore: await this.tokenStore(),
        onAuthorizationUrl: (url, serverName) => {
          if (serverName !== flow.serverName || isTerminal(flow.status)) return;
          const safeUrl = safeAuthorizationUrl(url);
          if (!safeUrl) {
            flow.status = 'failed';
            flow.error = 'The server returned an invalid authorization URL.';
            void this.finishFlow(flow);
            return;
          }
          flow.authorizationUrl = safeUrl;
          flow.status = 'waiting';
        },
        onServerStateChange: (change) => this.applyAuthorizationState(flow, change),
      });
      if (!handle || isTerminal(flow.status)) return;
      const manager = handle.services.clientManager;
      await manager.disconnectServer(flow.serverName);
      await manager.ensureConnected(flow.serverName);
      if (!isTerminal(flow.status)) flow.status = 'completed';
    } catch {
      if (!isTerminal(flow.status)) {
        flow.status = 'failed';
        flow.error = 'The MCP server could not complete authorization.';
      }
    } finally {
      if (!isTerminal(flow.status)) flow.status = 'completed';
      await this.finishFlow(flow);
    }
  }

  private applyAuthorizationState(flow: InternalAuthorizationFlow, change: McpServerStateChange): void {
    if (change.serverName !== flow.serverName || isTerminal(flow.status)) return;
    if (change.state === 'connected') flow.status = 'completed';
    else if (change.state === 'needs-auth' && flow.status === 'starting') flow.status = 'waiting';
    else if (change.state === 'failed') {
      flow.status = 'failed';
      flow.error = 'The MCP server rejected the authorization attempt.';
    }
  }

  private async finishFlow(flow: InternalAuthorizationFlow): Promise<void> {
    if (flow.timeout) clearTimeout(flow.timeout);
    flow.timeout = undefined;
    const owner = flow.owner;
    flow.owner = undefined;
    await owner?.dispose();
    if (flow.stagingDirectory) fs.rmSync(flow.stagingDirectory, { recursive: true, force: true });
    flow.stagingDirectory = undefined;
    this.busyRepositories.delete(flow.repositoryId);
    flow.retainedUntil = Date.now() + TERMINAL_FLOW_RETENTION_MS;
  }

  private sweepFlows(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) {
      if (flow.retainedUntil !== undefined && flow.retainedUntil <= now) this.flows.delete(id);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.flows.values()].map(async (flow) => {
        if (!isTerminal(flow.status)) flow.status = 'cancelled';
        await this.finishFlow(flow);
      }),
    );
    this.flows.clear();
    this.busyRepositories.clear();
  }
}
