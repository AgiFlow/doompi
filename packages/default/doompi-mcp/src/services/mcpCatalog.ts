import type { DoomMcpResolvedToolSelection } from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import type { McpServerView } from '../types/mcp.ts';
import type {
  McpCatalogSnapshot,
  McpCatalogState,
  McpCatalogStateChange,
  McpCatalogToolInput,
} from '../types/mcpCatalog.ts';
import type { CachedCatalog } from '../types/mcpRuntime.ts';
import type { DirectToolFilter } from './directTools.ts';

/** One downstream tool, with the name Pi will know it by. */
export interface CatalogTool {
  /** Name registered with Pi, prefixed by server. */
  piName: string;
  /** Name the downstream server knows. */
  toolName: string;
  serverName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CatalogEntry {
  name: string;
  /**
   * The last transition the server actually reported.
   *
   * Never `disabled`: a session disable is an override the user applied, not
   * something the server did, so it lives in its own field. Writing it into
   * `state` would destroy the value re-enabling has to return to.
   */
  state: McpCatalogState;
  /** Session-only override. Survives nothing; a restart returns to configuration. */
  disabled?: boolean;
  tools: CatalogTool[];
  resourceCount: number;
  error?: string;
}

/**
 * States where calling a tool cannot succeed, so its tools are withheld.
 *
 * `closed` is absent deliberately: a server closed after an idle timeout is
 * reconnected by the next call rather than gone. `disabled` is absent because it is
 * no longer a reachable transition; `entry.disabled` carries that instead.
 */
const UNAVAILABLE_STATES = new Set<McpCatalogState>(['failed', 'needs-auth']);

/** Where a server starts: known to the session, not yet dialled. */
const NOT_CONNECTED: McpCatalogState = 'not-connected';
const DISABLED: McpCatalogState = 'disabled';
const ALL_SERVERS_SELECTOR = '*';
const SELECTOR_SEPARATOR = '/';

/**
 * Pi's tool name for a downstream tool.
 *
 * Always prefixed, matching what `pi-mcp-adapter` produced by default. Tool names
 * are a contract with agent frontmatter selectors, transcripts, and user habit, so
 * they stay stable across the swap rather than following mcp-proxy's internal
 * scheme, which prefixes only on a clash.
 */
export function toPiToolName(serverName: string, toolName: string): string {
  return `${serverName.replace(/[^a-zA-Z0-9]/g, '_')}_${toolName}`;
}

function toCatalogTool(serverName: string, tool: McpCatalogToolInput): CatalogTool {
  return {
    piName: toPiToolName(serverName, tool.name),
    toolName: tool.name,
    serverName,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
  };
}

/**
 * The session's MCP servers and the tools registered for each.
 *
 * Seeded from the previous run's catalog so tools exist before any socket opens,
 * then folded forward as servers report in. Tools are never removed: Pi 0.84 has no
 * way to unregister one, so a tool whose server later fails stays registered and is
 * simply left out of the active set.
 */
export class McpCatalog {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly diagnostics: string[] = [];
  /** Pi names already claimed, so two servers cannot register the same one. */
  private readonly claimed = new Map<string, string>();

  /**
   * @param directTools - A child agent's tool selection. Undefined in a normal
   *   session, where every configured tool is available.
   */
  constructor(private readonly directTools?: DirectToolFilter) {}

  /**
   * Seeds the servers this session will connect to, all still `not-connected`.
   *
   * Configured names come first so a run with no cache still reports what it is
   * about to reach rather than looking empty; the cache then fills in their tools.
   * A cached server that configuration has since dropped is not seeded at all.
   */
  seed(catalog: CachedCatalog, configuredServers: readonly string[] = []): void {
    for (const name of configuredServers) {
      this.entries.set(name, { name, state: NOT_CONNECTED, tools: [], resourceCount: 0 });
    }
    for (const server of catalog.servers) {
      if (configuredServers.length > 0 && !this.entries.has(server.name)) continue;
      this.entries.set(server.name, {
        name: server.name,
        state: NOT_CONNECTED,
        tools: this.claimTools(server.name, server.tools),
        resourceCount: 0,
      });
    }
  }

  /**
   * Hides or restores a server's tools for this session.
   *
   * Only the flag moves: `state` keeps tracking what the server reports, so
   * re-enabling lands on the current truth rather than on a remembered value that
   * may have gone stale while the server was hidden.
   */
  setDisabled(serverName: string, disabled: boolean): void {
    const entry = this.entries.get(serverName);
    if (entry) entry.disabled = disabled;
    else
      this.entries.set(serverName, { name: serverName, state: NOT_CONNECTED, disabled, tools: [], resourceCount: 0 });
  }

  /** Records how many resources a server offered the last time they were listed. */
  setResourceCount(serverName: string, resourceCount: number): void {
    const entry = this.entries.get(serverName);
    if (entry) entry.resourceCount = resourceCount;
  }

  /**
   * Folds a live server transition into the catalog.
   *
   * Returns the tools that are new to this catalog, which is what the caller has to
   * register with Pi. A reconnect returns nothing, since its tools already exist.
   */
  applyStateChange(
    change: McpCatalogStateChange,
    tools: McpCatalogToolInput[] = [],
    resourceCount?: number,
  ): CatalogTool[] {
    const entry = this.entries.get(change.serverName) ?? {
      name: change.serverName,
      state: change.state,
      tools: [],
      resourceCount: 0,
    };
    entry.state = change.state;
    if (change.error) entry.error = change.error;
    else delete entry.error;
    if (resourceCount !== undefined) entry.resourceCount = resourceCount;

    const known = new Set(entry.tools.map((tool) => tool.toolName));
    const added = this.claimTools(
      change.serverName,
      tools.filter((tool) => !known.has(tool.name)),
    );
    entry.tools = [...entry.tools, ...added];
    this.entries.set(change.serverName, entry);
    return added;
  }

  /**
   * Tool names Pi should currently expose.
   *
   * Optimistic: a server that has not reported yet still contributes its cached
   * tools, because calling one connects it on demand. The live background pass can
   * take longer than Pi startup, so requiring `connected` first would make a warm
   * session needlessly start with no tools.
   *
   * Only a server that is known to be unusable, or one the user disabled, is held
   * back.
   */
  activeToolNames(): string[] {
    const names: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.disabled || UNAVAILABLE_STATES.has(entry.state)) continue;
      for (const tool of entry.tools) {
        if (this.directTools && !this.directTools.allows(entry.name, tool.toolName)) continue;
        names.push(tool.piName);
      }
    }
    return names;
  }

  /** Every tool ever registered, whether or not its server is reachable. */
  allTools(): CatalogTool[] {
    return [...this.entries.values()].flatMap((entry) => entry.tools);
  }

  /** Resolve configured selectors only to tool names this authoritative catalog confirms. */
  resolveToolSelectors(selectors: readonly string[]): readonly DoomMcpResolvedToolSelection[] {
    let allServers = false;
    const selectedServers = new Set<string>();
    const selectedTools = new Map<string, Set<string>>();
    for (const selection of selectors) {
      const item = selection.trim().replace(/\/+$/u, '');
      if (!item) continue;
      if (item === ALL_SERVERS_SELECTOR) {
        allServers = true;
        continue;
      }
      const separator = item.indexOf(SELECTOR_SEPARATOR);
      if (separator === -1) {
        selectedServers.add(item);
        continue;
      }
      const server = item.slice(0, separator);
      const tool = item.slice(separator + 1);
      if (!server) continue;
      if (!tool) {
        selectedServers.add(server);
        continue;
      }
      const names = selectedTools.get(server) ?? new Set<string>();
      names.add(tool);
      selectedTools.set(server, names);
    }

    const resolved: DoomMcpResolvedToolSelection[] = [];
    const seen = new Set<string>();
    for (const tool of this.allTools()) {
      const wholeServer = allServers || selectedServers.has(tool.serverName);
      if (!wholeServer && !selectedTools.get(tool.serverName)?.has(tool.toolName)) continue;
      if (seen.has(tool.piName)) continue;
      seen.add(tool.piName);
      resolved.push({ name: tool.piName, selector: `${tool.serverName}${SELECTOR_SEPARATOR}${tool.toolName}` });
    }
    return resolved;
  }

  findTool(piName: string): CatalogTool | undefined {
    return this.allTools().find((tool) => tool.piName === piName);
  }

  /**
   * The cross-extension status shape.
   *
   * A disabled server reports `disabled` as its state, because that is the one word
   * the wire contract has for "configured but contributing nothing", and consumers
   * outside this process have no use for the transition underneath it.
   */
  toSnapshot(): McpCatalogSnapshot {
    return {
      servers: [...this.entries.values()].map((entry) => ({
        name: entry.name,
        state: entry.disabled ? DISABLED : entry.state,
        tools: entry.tools.map((tool) => tool.piName),
        resourceCount: entry.resourceCount,
        ...(entry.error ? { error: entry.error } : {}),
      })),
    };
  }

  /**
   * The fuller picture the overlay renders.
   *
   * Carries what the snapshot cannot: each tool's downstream name and description,
   * whether a child agent's selection withholds it, and `enabled` as its own field
   * so the overlay can offer disable and enable against the real server state.
   */
  toView(): McpServerView[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      state: entry.state,
      tools: entry.tools.map((tool) => ({
        piName: tool.piName,
        toolName: tool.toolName,
        ...(tool.description ? { description: tool.description } : {}),
        active: !this.directTools || this.directTools.allows(entry.name, tool.toolName),
      })),
      resourceCount: entry.resourceCount,
      enabled: !entry.disabled,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  /** Problems worth surfacing to the user. Reported, never thrown. */
  getDiagnostics(): readonly string[] {
    return this.diagnostics;
  }

  /**
   * Records a problem for the user without interrupting whatever hit it.
   *
   * Deduplicated: a fault that recurs on every repaint would otherwise grow this
   * list for as long as the session runs, and the second copy tells nobody
   * anything the first did not.
   */
  addDiagnostic(diagnostic: string): void {
    if (!this.diagnostics.includes(diagnostic)) this.diagnostics.push(diagnostic);
  }

  /**
   * Assigns Pi names, dropping any that another server already owns.
   *
   * Two server names that normalize to the same prefix (`code-intel` and
   * `code_intel`) would otherwise have one silently shadow the other's tool.
   */
  private claimTools(serverName: string, tools: McpCatalogToolInput[]): CatalogTool[] {
    const claimed: CatalogTool[] = [];
    for (const tool of tools) {
      const candidate = toCatalogTool(serverName, tool);
      const owner = this.claimed.get(candidate.piName);
      if (owner !== undefined && owner !== serverName) {
        this.diagnostics.push(
          `MCP tool "${candidate.piName}" from "${serverName}" was dropped: "${owner}" already registered that name.`,
        );
        continue;
      }
      this.claimed.set(candidate.piName, serverName);
      claimed.push(candidate);
    }
    return claimed;
  }
}
