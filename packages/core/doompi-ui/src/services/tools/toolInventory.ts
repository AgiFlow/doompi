import type { McpServerSnapshot } from '@agimon-ai/doompi-extension-contracts/mcp-status';

export type ToolSourceKind = 'core' | 'mcp' | 'extension';

export interface ToolEntry {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: readonly string[];
  active: boolean;
}

export interface ToolSource {
  key: string;
  label: string;
  kind: ToolSourceKind;
  /** Server state for MCP sources, e.g. `disabled`; absent for core and extensions. */
  status?: string;
  /** The registering file for extension sources. */
  detail?: string;
  tools: readonly ToolEntry[];
}

/** One server row of the MCP status snapshot. */
export type McpServerStatus = McpServerSnapshot;

export interface ToolInfo {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: readonly string[];
  sourceInfo: { path: string; source?: string };
}

export interface ToolInventoryInput {
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  /** Absent when the MCP adapter is not loaded or has not published yet. */
  mcpServers?: readonly McpServerStatus[];
  resolveExtensionName?: (entryPath: string) => string;
  resolveExtensionToolSource?: (toolName: string) => string | undefined;
}

/** Pi tags its own tools with this source; everything else came from an extension. */
const BUILTIN_SOURCE = 'builtin';
/** Pi's structural tags for an extension path, neither of which is a package name. */
const CLI_SOURCE = 'cli';
const LOCAL_SOURCE = 'local';
const CORE_KEY = 'core';
const CORE_NAME = 'pi';
const MCP_KEY_PREFIX = 'mcp:';
/** Labels read name first, then kind, because the name is what the eye scans for. */
const KIND_SUFFIX: Record<ToolSourceKind, string> = { core: 'core', mcp: 'mcp', extension: 'extension' };
const CONNECTED_STATUS = 'connected';
const KIND_ORDER: Record<ToolSourceKind, number> = { core: 0, mcp: 1, extension: 2 };

/**
 * Server state worth reporting, which takes the place of the tool count.
 *
 * A connected server is the unremarkable case, so it keeps its count rather
 * than spending the column on a word that says nothing went wrong.
 */
function displayStatus(server: McpServerStatus): string | undefined {
  return server.state === CONNECTED_STATUS ? undefined : server.state.replace(/-/g, ' ');
}

function toEntry(tool: ToolInfo, activeTools: ReadonlySet<string>): ToolEntry {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    ...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
    active: activeTools.has(tool.name),
  };
}

function byName(left: ToolEntry, right: ToolEntry): number {
  return left.name.localeCompare(right.name);
}

function sourceLabel(name: string, kind: ToolSourceKind): string {
  return `${name} · ${KIND_SUFFIX[kind]}`;
}

/**
 * Indexes each server's declared tool names.
 *
 * The snapshot names its tools outright, so attribution is a lookup rather than a
 * guess at the naming scheme. A tool the snapshot does not claim falls through to
 * the extension that registered it.
 */
function serverByTool(servers: readonly McpServerStatus[]): Map<string, McpServerStatus> {
  const index = new Map<string, McpServerStatus>();
  for (const server of servers) {
    for (const toolName of server.tools) index.set(toolName, server);
  }
  return index;
}

/**
 * Groups the session's tools by where they came from: Pi itself, one group per
 * MCP server, then one per extension that registered a tool.
 *
 * Every MCP tool is registered by one extension, so `sourceInfo` cannot separate
 * servers; the status snapshot supplies the tool-to-server mapping instead.
 */
export function buildToolSources(input: ToolInventoryInput): readonly ToolSource[] {
  const activeTools = new Set(input.activeTools);
  const servers = input.mcpServers ?? [];
  const owningServer = serverByTool(servers);
  const core: ToolEntry[] = [];
  const mcpTools = new Map<string, ToolEntry[]>();
  const extensions = new Map<string, { label: string; detail: string; tools: ToolEntry[] }>();

  for (const tool of input.tools) {
    const entry = toEntry(tool, activeTools);
    const server = owningServer.get(tool.name);
    if (server) {
      const bucket = mcpTools.get(server.name);
      if (bucket) bucket.push(entry);
      else mcpTools.set(server.name, [entry]);
      continue;
    }
    if (tool.sourceInfo.source === BUILTIN_SOURCE) {
      core.push(entry);
      continue;
    }
    // A composed bundle has one Pi source path for every factory inside it. Doom's
    // compiler records the original entry at registration time so those extensions
    // remain separate here even though Pi can only see the outer bundle.
    const recordedPath = input.resolveExtensionToolSource?.(tool.name);
    const key = recordedPath ?? tool.sourceInfo.path;
    const group = extensions.get(key);
    if (group) group.tools.push(entry);
    else {
      const structuralSource =
        recordedPath !== undefined ||
        tool.sourceInfo.source === CLI_SOURCE ||
        tool.sourceInfo.source === LOCAL_SOURCE ||
        !tool.sourceInfo.source;
      const name = structuralSource
        ? (input.resolveExtensionName?.(key) ?? tool.sourceInfo.source ?? key)
        : (tool.sourceInfo.source ?? key);
      extensions.set(key, { label: sourceLabel(name, 'extension'), detail: key, tools: [entry] });
    }
  }

  const sources: ToolSource[] = [];
  if (core.length > 0) {
    sources.push({ key: CORE_KEY, label: sourceLabel(CORE_NAME, CORE_KEY), kind: CORE_KEY, tools: core.sort(byName) });
  }
  for (const server of servers) {
    const tools = mcpTools.get(server.name) ?? [];
    const status = displayStatus(server);
    // Every configured server is listed, including one with no tools: attribution
    // is exact now, so an empty list is a fact about the server rather than a
    // failure to recognise its tool names.
    sources.push({
      key: `${MCP_KEY_PREFIX}${server.name}`,
      label: sourceLabel(server.name, 'mcp'),
      kind: 'mcp',
      ...(status ? { status } : {}),
      tools: tools.sort(byName),
    });
  }
  for (const [key, group] of extensions) {
    sources.push({
      key,
      label: group.label,
      kind: 'extension',
      detail: group.detail,
      tools: group.tools.sort(byName),
    });
  }

  return sources.sort(
    (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.label.localeCompare(right.label),
  );
}
