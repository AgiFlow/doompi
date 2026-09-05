import type { McpStatusSnapshot } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import type { DoomMcpResolvedToolSelection } from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import type { McpClientManagerService, McpServerStateChange, TokenStore } from '@agimon-ai/mcp-proxy';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type CatalogTool, McpCatalog } from '../../services/mcpCatalog.ts';
import type { McpResourceView, McpServerView } from '../../types/mcp.ts';
import type { McpConfigGroups, McpConfigSource, McpSessionConfig } from '../../types/mcpConfig.ts';
import { buildMcpConfigGroups } from '../node/configSources.ts';
import { type McpRuntimeOwner, readCachedCatalog } from '../node/mcpRuntime.ts';
import { readDirectToolFilter } from '../process/directToolsEnvironment.ts';
import { readSessionConfig } from '../process/sessionConfig.ts';
import { applyActiveTools, registerNewTools } from './mcpTools.ts';

/** Raised by anything needing a live container before one has been built. */
const RUNTIME_NOT_STARTED = 'The MCP runtime has not started yet.';
const AUTHORIZATION_URL_NOT_READY = 'No authorization page is waiting for this MCP server.';

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate !== 'object' || candidate === null) return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

export function mcpConfigurationFingerprint(configuration: McpSessionConfig): string {
  return canonicalJson({
    enabled: configuration.enabled ?? true,
    repoRoot: configuration.repoRoot,
    stagingDirectory: configuration.stagingDirectory,
    generatedConfigPath: configuration.generatedConfigPath,
    pluginConfigPaths: configuration.pluginConfigPaths ?? [],
    sources: configuration.sources ?? [],
    allowlist: {
      servers: [...(configuration.allowlist?.servers ?? [])].sort((left, right) => left.localeCompare(right)),
      proxy: [...(configuration.allowlist?.proxy ?? [])].sort((left, right) => left.localeCompare(right)),
    },
  });
}

function toolRegistrationFingerprint(tool: CatalogTool): string {
  return canonicalJson({
    serverName: tool.serverName,
    toolName: tool.toolName,
    inputSchema: tool.inputSchema,
  });
}

export interface McpSessionOptions {
  pi: ExtensionAPI;
  environment?: NodeJS.ProcessEnv;
  /** Surfaces an OAuth URL, opening it when an explicit authorization requested that. */
  onAuthorizationUrl?: (url: URL, serverName: string, options: { openBrowser: boolean }) => void | Promise<void>;
  /** Overrides the OS keyring store, for tests. */
  tokenStore?: TokenStore;
}

/**
 * The MCP picture for one Pi session.
 *
 * Install is synchronous and cheap: the previous run's catalog is read off disk and
 * its tools registered, so Pi's first turn already has them. Connecting happens on
 * a detached promise afterwards, and each server folds into the active tool set as
 * it lands. Nothing on this path waits for a socket.
 */
export class McpSession {
  private readonly pi: ExtensionAPI;
  /** Created after session_start, never while Pi is importing extensions. */
  private runtime: McpRuntimeOwner | undefined;
  private catalog: McpCatalog;
  private groups: McpConfigGroups = {
    shared: { configSources: [], configPaths: [], serverNames: [] },
    sessionLocal: { configSources: [], configPaths: [], serverNames: [] },
    droppedServers: [],
    diagnostics: [],
  };
  private readonly options: McpSessionOptions;
  /** Resources per server, listed on demand. Errors are never cached, so a retry re-dials. */
  private readonly resourceCache = new Map<string, readonly McpResourceView[]>();
  private readonly changeListeners = new Set<() => void>();
  /** Authorization URLs waiting to be opened, by server. */
  private readonly authorizationUrls = new Map<string, string>();
  /** Servers whose explicit auth action should launch the browser when its URL arrives. */
  private readonly browserAuthorizationRequests = new Set<string>();
  /** Explicit session disconnects fence late discovery and stale tool invocations. */
  private readonly disconnectedServers = new Set<string>();
  /** Invalidates deferred startup work when a session reloads or shuts down. */
  private lifecycleGeneration = 0;
  private configurationFingerprint: string | undefined;
  /** Pi wrappers survive configuration changes because the host cannot unregister them. */
  private readonly registeredToolFingerprints = new Map<string, string>();
  private readonly historicallyOwnedNames = new Set<string>();
  private readonly incompatibleNames = new Set<string>();

  /** Resolved per tool call, so a registration outlives the container it was made under. */
  private readonly clientManager = (): McpClientManagerService | undefined =>
    this.runtime?.getServices()?.clientManager;

  constructor(options: McpSessionOptions) {
    this.pi = options.pi;
    this.options = options;
    this.catalog = this.createCatalog();
  }

  /**
   * Applies the tool set to Pi. Runs on session start, never during install.
   *
   * Pi's active-list calls throw until the runtime is bound, so the tools
   * registered at install stay at Pi's default visibility until this runs, which
   * is the first point the session can express that nothing has connected yet.
   */
  activate(): void {
    this.applyActiveTools();
  }

  private createCatalog(): McpCatalog {
    return new McpCatalog(readDirectToolFilter(this.options.environment));
  }

  /**
   * Registers the cached catalog with Pi. Runs at extension install.
   *
   * Returns the servers it seeded, so a caller can report what the session started
   * with before anything connected.
   */
  install(configuration: McpSessionConfig = readSessionConfig(this.options.environment)): McpStatusSnapshot {
    this.bindConfiguration(configuration);
    return this.catalog.toSnapshot();
  }

  /** Replaces the complete MCP projection and retires the previous live owner. */
  async reconfigure(configuration: McpSessionConfig): Promise<void> {
    const fingerprint = mcpConfigurationFingerprint(configuration);
    if (fingerprint === this.configurationFingerprint) {
      if (!this.runtime?.getServices()) this.startDetached();
      return;
    }

    const generation = ++this.lifecycleGeneration;
    const retiredRuntime = this.runtime;
    this.runtime = undefined;
    await retiredRuntime?.dispose();
    if (generation !== this.lifecycleGeneration) return;
    this.resourceCache.clear();
    this.authorizationUrls.clear();
    this.browserAuthorizationRequests.clear();
    this.bindConfiguration(configuration);
    this.applyActiveTools();
    this.emitChange();
    this.startDetached();
  }

  private bindConfiguration(configuration: McpSessionConfig): void {
    this.configurationFingerprint = mcpConfigurationFingerprint(configuration);
    this.groups = buildMcpConfigGroups(configuration);
    this.disconnectedServers.clear();
    this.catalog = this.createCatalog();
    // Doom embeds the client runtime, so upstreams referenced by a proxy wrapper
    // remain individual servers in the catalog rather than collapsing into it.
    const configuredServers = [
      ...new Set([...this.groups.sessionLocal.serverNames, ...this.groups.shared.serverNames]),
    ];
    this.catalog.seed(readCachedCatalog(this.configSources()), configuredServers);
    for (const diagnostic of this.groups.diagnostics) this.catalog.addDiagnostic(diagnostic);
    this.registerTools(this.catalog.allTools());
  }

  private registerTools(tools: readonly CatalogTool[]): void {
    const unseen: CatalogTool[] = [];
    for (const tool of tools) {
      const fingerprint = toolRegistrationFingerprint(tool);
      const registered = this.registeredToolFingerprints.get(tool.piName);
      this.historicallyOwnedNames.add(tool.piName);
      if (registered === undefined) {
        this.registeredToolFingerprints.set(tool.piName, fingerprint);
        this.incompatibleNames.delete(tool.piName);
        unseen.push(tool);
        continue;
      }
      if (registered === fingerprint) {
        this.incompatibleNames.delete(tool.piName);
        continue;
      }
      this.incompatibleNames.add(tool.piName);
      this.catalog.addDiagnostic(
        `MCP tool "${tool.piName}" changed identity or input schema and is hidden until Pi is relaunched.`,
      );
    }
    registerNewTools(this.pi, this.clientManager, unseen, (tool) => this.isToolAvailable(tool));
  }

  private isToolAvailable(registeredTool: CatalogTool): boolean {
    if (this.disconnectedServers.has(registeredTool.serverName) || this.incompatibleNames.has(registeredTool.piName))
      return false;
    const current = this.catalog.findTool(registeredTool.piName);
    return (
      current !== undefined && toolRegistrationFingerprint(current) === toolRegistrationFingerprint(registeredTool)
    );
  }

  private applyActiveTools(): void {
    const unavailable = new Set(this.incompatibleNames);
    for (const tool of this.catalog.allTools()) {
      if (this.disconnectedServers.has(tool.serverName)) unavailable.add(tool.piName);
    }
    applyActiveTools(this.pi, this.catalog, this.historicallyOwnedNames, unavailable);
  }

  private startDetached(): void {
    void this.start().catch((error: unknown) => {
      this.catalog.addDiagnostic(
        `Could not start the MCP runtime: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.emitChange();
    });
  }

  /**
   * Starts connecting. Never awaited on Pi's critical path.
   *
   * Resolves once the container exists, not once servers are reachable. A start
   * that a newer generation superseded resolves to nothing and registers nothing.
   */
  async start(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.disconnectedServers.clear();
    // Explicit disabled and empty Doom projections must not instantiate any
    // runtime collaborator, including the keyring-backed token store.
    if (this.configuredServerNames().length === 0) return;
    const [{ createTokenStore }, { McpRuntimeOwner }] = await Promise.all([
      import('../node/keyringTokenStore.ts'),
      import('../node/mcpRuntime.ts'),
    ]);
    if (generation !== this.lifecycleGeneration) return;
    this.runtime ??= new McpRuntimeOwner();
    const runtime = this.runtime;
    // The container is about to be replaced, so every resource list read from the
    // old one is now hearsay.
    this.resourceCache.clear();
    const configSources = this.configSources();
    const tokenStore = this.options.tokenStore ?? (await createTokenStore());
    await runtime.start({
      configSources,
      tokenStore,
      onAuthorizationUrl: (url, serverName) => this.onAuthorizationUrl(url, serverName, generation),
      onServerStateChange: (change) => this.onServerStateChange(change, generation),
    });
    // Shutdown can land while the proxy package or token store is loading. Make
    // sure that late container cannot survive and mutate a closed Pi session.
    if (generation !== this.lifecycleGeneration) await runtime.dispose();
  }

  /**
   * Records the URL a flow is waiting on, then passes it to the host.
   *
   * Kept here as well as announced, because the announcement lands in the
   * transcript and the panel a user starts the flow from covers it. Host work is
   * detached so a failed desktop browser launch never cancels a still-usable OAuth
   * callback; the overlay retains a clickable fallback and a retry action.
   */
  private onAuthorizationUrl(url: URL, serverName: string, generation: number): void {
    if (generation !== this.lifecycleGeneration || this.disconnectedServers.has(serverName)) return;
    this.authorizationUrls.set(serverName, url.toString());
    this.emitChange();
    const openBrowser = this.browserAuthorizationRequests.has(serverName);
    void Promise.resolve()
      .then(() => this.options.onAuthorizationUrl?.(url, serverName, { openBrowser }))
      .catch((error: unknown) => {
        if (generation !== this.lifecycleGeneration) return;
        const detail = error instanceof Error ? error.message : String(error);
        this.catalog.addDiagnostic(`Could not open authorization page for "${serverName}": ${detail}`);
        this.emitChange();
      });
  }

  /** Ordered layers for the one in-process client container. */
  private configSources(): McpConfigSource[] {
    return [...this.groups.sessionLocal.configSources, ...this.groups.shared.configSources];
  }

  private configuredServerNames(): string[] {
    return [...new Set([...this.groups.sessionLocal.serverNames, ...this.groups.shared.serverNames])];
  }

  /** Closes only this session's connection. Saved OAuth credentials are untouched. */
  async disconnect(serverName: string): Promise<void> {
    if (!this.configuredServerNames().includes(serverName)) throw new Error(`Unknown MCP server: ${serverName}`);
    const clientManager = this.clientManager();
    if (!clientManager) throw new Error(RUNTIME_NOT_STARTED);
    const generation = this.lifecycleGeneration;
    this.disconnectedServers.add(serverName);
    try {
      await clientManager.disconnectServer(serverName);
    } catch (error) {
      if (generation === this.lifecycleGeneration) this.disconnectedServers.delete(serverName);
      throw error;
    }
    if (generation !== this.lifecycleGeneration) return;
    this.resourceCache.delete(serverName);
    this.authorizationUrls.delete(serverName);
    this.browserAuthorizationRequests.delete(serverName);
    this.catalog.applyStateChange({ serverName, state: 'closed' }, []);
    this.applyActiveTools();
    this.emitChange();
  }

  /**
   * Reconnects one server, running its OAuth flow when it demands one.
   *
   * The existing connection is dropped first: a server holding a stale token would
   * otherwise keep answering from cache and never reach the authorization step.
   */
  async reauthorize(serverName: string): Promise<void> {
    const clientManager = this.clientManager();
    if (!clientManager) throw new Error(RUNTIME_NOT_STARTED);
    this.disconnectedServers.delete(serverName);
    // What this server offers is exactly what the reconnect is about to settle.
    this.resourceCache.delete(serverName);
    if (this.authorizationUrls.delete(serverName)) this.emitChange();
    this.browserAuthorizationRequests.add(serverName);
    try {
      await clientManager.disconnectServer(serverName);
      await clientManager.ensureConnected(serverName);
    } finally {
      this.browserAuthorizationRequests.delete(serverName);
    }
  }

  /** Reopens the URL already reserved for a flow without restarting that flow. */
  async openAuthorizationPage(serverName: string): Promise<void> {
    const authorizationUrl = this.authorizationUrls.get(serverName);
    if (!authorizationUrl) throw new Error(AUTHORIZATION_URL_NOT_READY);
    const onAuthorizationUrl = this.options.onAuthorizationUrl;
    if (!onAuthorizationUrl) throw new Error('This host cannot open authorization pages.');
    await onAuthorizationUrl(new URL(authorizationUrl), serverName, { openBrowser: true });
  }

  getSnapshot(): McpStatusSnapshot {
    return this.catalog.toSnapshot();
  }

  resolveToolSelectors(selectors: readonly string[]): readonly DoomMcpResolvedToolSelection[] {
    return this.catalog.resolveToolSelectors(selectors);
  }

  /** The fuller picture the overlay renders, with tool names and descriptions. */
  getServers(): readonly McpServerView[] {
    return this.catalog.toView().map((server) => {
      const authorizationUrl = this.authorizationUrls.get(server.name);
      return authorizationUrl ? { ...server, authorizationUrl } : server;
    });
  }

  /**
   * Hides or restores a server's tools for the rest of this session.
   *
   * Deliberately does not disconnect: this is a session visibility control, so a
   * later enable is instant and does not discard an authenticated live connection.
   * Because each catalog row is now an actual downstream server, the control acts
   * on only that server's tools rather than on an aggregate proxy group.
   *
   * Nothing is re-registered on the way back: Pi 0.84 cannot unregister a tool, so
   * every tool is still registered and only its place in the active list moved.
   */
  setEnabled(serverName: string, enabled: boolean): void {
    this.catalog.setDisabled(serverName, !enabled);
    this.applyActiveTools();
    this.emitChange();
  }

  /**
   * Lists one server's resources, from cache unless asked for a fresh call.
   *
   * The cache lives here rather than in the overlay so closing and reopening the
   * panel does not re-dial. A rejection is never cached, so a server that has no
   * `resources/list` capability, or one that was briefly unreachable, is retried by
   * the next request rather than remembered as empty.
   */
  async listResources(serverName: string, options: { refresh?: boolean } = {}): Promise<readonly McpResourceView[]> {
    if (this.disconnectedServers.has(serverName)) throw new Error(`MCP server is disconnected: ${serverName}`);
    if (!options.refresh) {
      const cached = this.resourceCache.get(serverName);
      if (cached) return cached;
    }
    const runtime = this.runtime;
    const services = runtime?.getServices();
    if (!runtime || !services) throw new Error(RUNTIME_NOT_STARTED);
    const connection = await services.clientManager.ensureConnected(serverName);
    const resources = await connection.listResources();
    // A reload that landed while this was in flight retired the container it was
    // read from, so the answer is returned to the caller but never written down.
    if (!runtime.isCurrent(services)) return resources;
    this.resourceCache.set(serverName, resources);
    this.catalog.setResourceCount(serverName, resources.length);
    this.emitChange();
    return resources;
  }

  /** Fires whenever the server picture changes. Returns its own disposer. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /**
   * Announces a change to whoever is watching.
   *
   * Listener failures are contained rather than propagated: this runs inside the
   * continuation that folds a server into Pi's tool set, and a throw escaping here
   * would abandon that fold, leaving the session silently short of tools because
   * something failed to repaint.
   */
  private emitChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        // Recorded rather than rethrown: a watcher that cannot render is a defect
        // worth seeing, but not one worth abandoning the tool set over.
        this.catalog.addDiagnostic(
          `An MCP change listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  getDiagnostics(): readonly string[] {
    return this.catalog.getDiagnostics();
  }

  async dispose(): Promise<void> {
    ++this.lifecycleGeneration;
    this.browserAuthorizationRequests.clear();
    this.authorizationUrls.clear();
    this.resourceCache.clear();
    const retiredRuntime = this.runtime;
    this.runtime = undefined;
    await retiredRuntime?.dispose();
  }

  /**
   * Folds one server transition into Pi's tool set.
   *
   * The tool list is read from the live connection rather than the state event,
   * which carries no tools; a server that is not readable contributes none and its
   * cached tools simply stay inactive.
   *
   * `ensureConnected` rather than `getClient`: the manager announces `connected`
   * before it registers the client, so a listener that looks the client up
   * synchronously finds nothing and the server lands with an empty tool list.
   * This handler runs detached from the connect, so awaiting it cannot deadlock.
   */
  private onServerStateChange(change: McpServerStateChange, generation: number): void {
    if (generation !== this.lifecycleGeneration || this.disconnectedServers.has(change.serverName)) return;
    // The flow this URL belonged to is over, one way or the other: a server that
    // reached a terminal state is not still waiting on a redirect.
    if (change.state !== 'connecting' && change.state !== 'needs-auth') {
      this.authorizationUrls.delete(change.serverName);
    }
    const runtime = this.runtime;
    const services = runtime?.getServices();
    const tools =
      change.state === 'connected' && services
        ? services.clientManager.ensureConnected(change.serverName).then((connection) => connection.listTools())
        : Promise.resolve([]);
    void tools
      .catch(() => [])
      .then((tools) => {
        if (
          generation !== this.lifecycleGeneration ||
          !runtime?.isCurrent(services) ||
          this.disconnectedServers.has(change.serverName)
        )
          return;
        const added = this.catalog.applyStateChange(change, tools);
        this.registerTools(added);
        this.applyActiveTools();
        this.emitChange();
      });
  }
}
