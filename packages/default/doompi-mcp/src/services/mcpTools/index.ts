import type { DoomHeadlessToolResult } from '@agimon-ai/doompi-core/headless';
import { definePiTool, type PiToolDeclaration } from '@agimon-ai/doompi-core/piExtension';
import type { McpClientManagerService } from '@agimon-ai/mcp-proxy';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { TSchema } from 'typebox';

import { mcpToolExecutionMetadata, normalizeMcpAppMetadata, type CatalogTool } from '../../services/mcpCatalog';
import type { McpAppPresentation, McpResultBlock, McpToolDetails } from '../../types/webMcp';

const MAX_APP_RESULT_BYTES = 1024 * 1024;
const appSnapshots = new WeakMap<CallToolResult, McpAppPresentation>();

/** Clone before output guards can replace structured data or mutate the source. */
export function captureMcpAppResult(tool: CatalogTool, result: CallToolResult): McpAppPresentation | undefined {
  const app = normalizeMcpAppMetadata(tool._meta);
  if (!app.appVisible && !app.resourceUri) return undefined;
  try {
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json, 'utf8') > MAX_APP_RESULT_BYTES) return undefined;
    return {
      version: 1,
      ...(app.resourceUri === undefined ? {} : { resourceUri: app.resourceUri, protocol: app.protocol }),
      result: JSON.parse(json) as CallToolResult,
    };
  } catch {
    // Non-JSON or oversized results retain their normal text fallback without an App.
    return undefined;
  }
}

/** Historical details are untrusted JSON; reject malformed or unbounded snapshots. */
export function parseMcpAppSnapshot(value: unknown): McpAppPresentation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.result !== 'object' ||
    record.result === null ||
    Array.isArray(record.result)
  )
    return undefined;
  if (
    record.resourceUri !== undefined &&
    (typeof record.resourceUri !== 'string' ||
      !record.resourceUri.startsWith('ui://') ||
      record.resourceUri.length > 8192)
  )
    return undefined;
  if (record.protocol !== undefined && record.protocol !== 'mcp' && record.protocol !== 'openai') return undefined;
  if ((record.resourceUri === undefined) !== (record.protocol === undefined)) return undefined;
  const result = record.result as Record<string, unknown>;
  if (!Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== 'boolean'))
    return undefined;
  if (
    result.content.some(
      (block: unknown) =>
        typeof block !== 'object' || block === null || !('type' in block) || typeof block.type !== 'string',
    )
  )
    return undefined;
  try {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, 'utf8') > MAX_APP_RESULT_BYTES) return undefined;
    return JSON.parse(json) as McpAppPresentation;
  } catch {
    // A non-JSON persisted payload cannot be replayed safely.
    return undefined;
  }
}

/** Associate the original private payload with the guarded result without widening MCP wire output. */
export function retainMcpAppResult(result: CallToolResult, snapshot: McpAppPresentation | undefined): void {
  if (snapshot) appSnapshots.set(result, snapshot);
}

/** Pi requires a schema; a downstream tool that declares none takes any object. */
const ANY_OBJECT_SCHEMA = { type: 'object', properties: {} };

type ContentBlock = CallToolResult['content'][number];

/** The text of a downstream result: its text blocks joined, which is what the model reads. */
function resultText(result: Pick<CallToolResult, 'content'>): string {
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
  const structured = structuredRecord(result);
  if (structured !== undefined) blocks.push({ type: 'structured', value: structured });
  return blocks;
}

/**
 * MCP v2 allows any JSON value as structured content; DoomPi's contract carries an object, which
 * is all v1 permitted. Any other value still reaches the model through the text fallback.
 */
function structuredRecord(result: CallToolResult): Record<string, unknown> | undefined {
  const value = result.structuredContent;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  const normalized = toHeadlessToolResult(tool, result);
  if (normalized.isError) throw new Error(resultText(normalized));
  // MCP structured content arrived as JSON, which is what Pi 0.99 types it as.
  return normalized as AgentToolResult<McpToolDetails>;
}

/** Remote MCP preserves error flags and public structured results instead of Pi's thrown-error convention. */
export function toHeadlessToolResult(
  tool: CatalogTool,
  result: CallToolResult,
): DoomHeadlessToolResult & { details: McpToolDetails } {
  const text =
    resultText(result) ||
    (result.structuredContent === undefined ? 'No output.' : JSON.stringify(result.structuredContent));
  const blocks = resultBlocks(result);
  const structured = structuredRecord(result);
  const app =
    appSnapshots.get(result) ??
    (normalizeMcpAppMetadata(tool._meta).resourceUri === undefined ? undefined : captureMcpAppResult(tool, result));
  return {
    content: [{ type: 'text', text }, ...resultImages(result)],
    ...(structured === undefined ? {} : { structuredContent: structured }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
    details: {
      server: tool.serverName,
      tool: tool.toolName,
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(app === undefined ? {} : { app }),
    },
  };
}

/**
 * Supplies the live client manager, or nothing before the runtime has started.
 *
 * A getter rather than the manager itself: tools are registered from the cached
 * catalog before any container exists, and the same registration has to reach
 * whichever container is live when the tool is finally called.
 */
export type McpToolRenderers = Pick<ToolDefinition<TSchema, McpToolDetails>, 'renderCall' | 'renderResult'>;

export type ClientManagerSource = () => McpClientManagerService | undefined;
export type McpToolAvailability = (tool: CatalogTool) => boolean;

const ALWAYS_AVAILABLE: McpToolAvailability = () => true;

/**
 * Registers one downstream tool with Pi.
 *
 * Registration is permanent for the session: Pi 0.84 has no `unregisterTool`, so
 * visibility is controlled through a tool-surface restriction instead. The connection is
 * resolved at execution time rather than captured, so a server that reconnects
 * underneath keeps working.
 */
export function createMcpTool(
  clientManagerSource: ClientManagerSource,
  tool: CatalogTool,
  isAvailable: McpToolAvailability = ALWAYS_AVAILABLE,
  renderers: McpToolRenderers = {},
  executeTool?: (
    tool: CatalogTool,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<CallToolResult>,
): PiToolDeclaration {
  return definePiTool({
    name: tool.piName,
    label: `${tool.serverName}: ${tool.toolName}`,
    description: tool.description ?? `${tool.toolName} on the ${tool.serverName} MCP server.`,
    // The schema arrives as JSON Schema at runtime, so it is wrapped rather than
    // built: TypeBox validates the shape without it having to be declared here.
    // Type.Unsafe only brands this runtime JSON Schema object. A type cast keeps
    // cached stub registration from evaluating the whole TypeBox package.
    parameters: (Object.keys(tool.inputSchema).length > 0 ? tool.inputSchema : ANY_OBJECT_SCHEMA) as TSchema,
    ...(tool._meta === undefined ? {} : { _meta: mcpToolExecutionMetadata(tool) }),
    renderShell: 'self',
    ...renderers,
    async execute(_toolCallId, params, signal) {
      if (!isAvailable(tool)) {
        throw new Error(`MCP tool ${tool.piName} is not available in the current session configuration.`);
      }
      if (executeTool) {
        return toAgentToolResult(tool, await executeTool(tool, (params ?? {}) as Record<string, unknown>, signal));
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
