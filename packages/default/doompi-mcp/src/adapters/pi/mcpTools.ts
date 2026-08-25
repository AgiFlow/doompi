import type { McpClientManagerService } from '@agimon-ai/mcp-proxy';
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TSchema } from 'typebox';
import type { CatalogTool, McpCatalog } from '../../services/mcpCatalog.ts';
import { renderMcpCall, renderMcpResult } from '../../tui/mcpToolRender.ts';
import type { McpResultBlock, McpToolDetails } from '../../types/webMcp.ts';

/** Pi requires a schema; a downstream tool that declares none takes any object. */
const ANY_OBJECT_SCHEMA = { type: 'object', properties: {} };

type ContentBlock = CallToolResult['content'][number];

/** The text of a downstream result: its text blocks joined, which is what the model reads. */
function resultText(result: CallToolResult): string {
  return (result.content ?? [])
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

/** The image blocks, re-emitted as Pi's own image content so the model and the cockpit both see them. */
function resultImages(result: CallToolResult): AgentToolResult<McpToolDetails>['content'] {
  return (result.content ?? []).flatMap((block: ContentBlock) =>
    block.type === 'image' ? [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }] : [],
  );
}

/**
 * Everything else a downstream result carried: audio, resource links, embedded
 * resources, and the structured content. Pi's content cannot hold them, so
 * they ride the result's details for the cockpit's MCP message to render.
 */
function resultBlocks(result: CallToolResult): McpResultBlock[] {
  const blocks: McpResultBlock[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'audio') blocks.push({ type: 'audio', data: block.data, mimeType: block.mimeType });
    else if (block.type === 'resource_link') {
      blocks.push({
        type: 'resource_link',
        uri: block.uri,
        name: block.name,
        ...(block.title === undefined ? {} : { title: block.title }),
        ...(block.description === undefined ? {} : { description: block.description }),
        ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
      });
    } else if (block.type === 'resource') {
      const resource = block.resource;
      blocks.push({
        type: 'resource',
        uri: resource.uri,
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
        ...('text' in resource && typeof resource.text === 'string' ? { text: resource.text } : {}),
        ...('blob' in resource && typeof resource.blob === 'string' ? { blob: resource.blob } : {}),
      });
    }
  }
  if (typeof result.structuredContent === 'object' && result.structuredContent !== null) {
    blocks.push({ type: 'structured', value: result.structuredContent });
  }
  return blocks;
}

/**
 * Turns a downstream result into a Pi tool result.
 *
 * `isError` is raised rather than returned: Pi shows a thrown message as a failed
 * call, and returning the text would present a server-side error as a success.
 * The text is what the model reads; images join it as Pi content, and every
 * other block kind reaches the cockpit through the details.
 */
export function toAgentToolResult(tool: CatalogTool, result: CallToolResult): AgentToolResult<McpToolDetails> {
  const text = resultText(result) || 'No output.';
  if (result.isError) throw new Error(text);
  const blocks = resultBlocks(result);
  return {
    content: [{ type: 'text', text }, ...resultImages(result)],
    details: { server: tool.serverName, tool: tool.toolName, ...(blocks.length > 0 ? { blocks } : {}) },
  };
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
