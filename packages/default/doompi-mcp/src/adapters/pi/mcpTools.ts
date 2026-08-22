import type { McpClientManagerService } from '@agimon-ai/mcp-proxy';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TSchema } from 'typebox';
import type { CatalogTool, McpCatalog } from '../../services/mcpCatalog.ts';
import { renderMcpCall, renderMcpResult } from '../../tui/mcpToolRender.ts';

/** Pi requires a schema; a downstream tool that declares none takes any object. */
const ANY_OBJECT_SCHEMA = { type: 'object', properties: {} };

interface McpToolDetails {
  server: string;
  tool: string;
  [key: string]: unknown;
}

/** Reads the text of a downstream result, dropping blocks Pi cannot render. */
function resultText(result: CallToolResult): string {
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Turns a downstream result into a Pi tool result.
 *
 * `isError` is raised rather than returned: Pi shows a thrown message as a failed
 * call, and returning the text would present a server-side error as a success.
 */
export function toAgentToolResult(tool: CatalogTool, result: CallToolResult): AgentToolResult<McpToolDetails> {
  const text = resultText(result) || 'No output.';
  if (result.isError) throw new Error(text);
  return { content: [{ type: 'text', text }], details: { server: tool.serverName, tool: tool.toolName } };
}

/**
 * Supplies the live client manager, or nothing before the runtime has started.
 *
 * A getter rather than the manager itself: tools are registered from the cached
 * catalog before any container exists, and the same registration has to reach
 * whichever container is live when the tool is finally called.
 */
export type ClientManagerSource = () => McpClientManagerService | undefined;
export type McpToolAvailability = (tool: CatalogTool) => boolean;

const ALWAYS_AVAILABLE: McpToolAvailability = () => true;

/**
 * Registers one downstream tool with Pi.
 *
 * Registration is permanent for the session: Pi 0.84 has no `unregisterTool`, so
 * visibility is controlled through the active list instead. The connection is
 * resolved at execution time rather than captured, so a server that reconnects
 * underneath keeps working.
 */
export function registerMcpTool(
  pi: ExtensionAPI,
  clientManagerSource: ClientManagerSource,
  tool: CatalogTool,
  isAvailable: McpToolAvailability = ALWAYS_AVAILABLE,
): void {
  pi.registerTool({
    name: tool.piName,
    label: `${tool.serverName}: ${tool.toolName}`,
    description: tool.description ?? `${tool.toolName} on the ${tool.serverName} MCP server.`,
    // The schema arrives as JSON Schema at runtime, so it is wrapped rather than
    // built: TypeBox validates the shape without it having to be declared here.
    // Type.Unsafe only brands this runtime JSON Schema object. A type cast keeps
    // cached stub registration from evaluating the whole TypeBox package.
    parameters: (Object.keys(tool.inputSchema).length > 0 ? tool.inputSchema : ANY_OBJECT_SCHEMA) as TSchema,
    renderShell: 'self',
    renderCall: (params, theme) => renderMcpCall(tool, params as Record<string, unknown>, theme),
    renderResult: (result, options, theme, context) =>
      renderMcpResult(result, { ...options, isError: context.isError }, theme),
    async execute(_toolCallId, params) {
      if (!isAvailable(tool)) {
        throw new Error(`MCP tool ${tool.piName} is not available in the current session configuration.`);
      }
      const clientManager = clientManagerSource();
      if (!clientManager) {
        throw new Error(`The MCP runtime is not ready, so ${tool.serverName} cannot be reached yet.`);
      }
      const connection = await clientManager.ensureConnected(tool.serverName);
      const timeout = clientManager.getServerRequestTimeout(tool.serverName);
      const result = await connection.callTool(
        tool.toolName,
        (params ?? {}) as Record<string, unknown>,
        timeout === undefined ? undefined : { timeout },
      );
      return toAgentToolResult(tool, result);
    },
  });
}

/**
 * Registers tools that are new to Pi.
 *
 * Separate from the active list because Pi allows `registerTool` during extension
 * loading but not `getActiveTools`/`setActiveTools`, which throw until the runtime
 * is bound. This half is therefore safe to run at install; `applyActiveTools` is
 * not, and waits for the session to start.
 */
export function registerNewTools(
  pi: ExtensionAPI,
  clientManagerSource: ClientManagerSource,
  newTools: readonly CatalogTool[],
  isAvailable: McpToolAvailability = ALWAYS_AVAILABLE,
): void {
  for (const tool of newTools) registerMcpTool(pi, clientManagerSource, tool, isAvailable);
}

/**
 * Recomputes which of this extension's tools Pi exposes.
 *
 * Rebuilt from scratch every time, so a server that failed drops out and one that
 * reconnected comes back. Only valid once the session has started.
 */
export function applyActiveTools(
  pi: ExtensionAPI,
  catalog: McpCatalog,
  historicallyOwnedNames: ReadonlySet<string> = new Set(catalog.allTools().map((tool) => tool.piName)),
  incompatibleNames: ReadonlySet<string> = new Set(),
): void {
  // Tools this extension does not own are carried through untouched: the active
  // list is global, and rebuilding it from MCP alone would hide everything else.
  // Historical ownership matters after reconfiguration because Pi cannot unregister
  // a wrapper that the new domain no longer selects.
  const others = pi.getActiveTools().filter((name) => !historicallyOwnedNames.has(name));
  const active = catalog.activeToolNames().filter((name) => !incompatibleNames.has(name));
  pi.setActiveTools([...others, ...active]);
}
