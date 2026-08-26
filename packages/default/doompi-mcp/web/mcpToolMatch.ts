import type { McpResultBlock } from '../src/types/webMcp.ts';

/**
 * Pure view logic for MCP tool cards, the browser counterpart of
 * src/tui/mcpToolRender.ts. MCP tools are registered under `<server>_<tool>`,
 * so the plugin recognises a call by the server names the session publishes.
 */

/**
 * The footer status the session half publishes (src/adapters/pi/mcpConstants.ts
 * MCP_STATUS_KEY). Duplicated because web/ may import only src/types; a test
 * keeps the two literals equal.
 */
export const MCP_STATUS_KEY = 'doom-mcp';
const SERVER_SEPARATOR = ',';
const PI_NAME_SEPARATOR = '_';
const MAX_ARGUMENTS = 3;
/** Text lines kept in the collapsed result, before the card is expanded. */
const COLLAPSED_RESULT_LINES = 12;

export interface McpToolIdentity {
  server: string;
  tool: string;
}

/** The server names the session reports, in the order it listed them. */
export function mcpServers(statuses: Readonly<Record<string, string>>): string[] {
  const raw = statuses[MCP_STATUS_KEY];
  if (raw === undefined) return [];
  return raw
    .split(SERVER_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Splits a Pi tool name into its MCP server and tool. The longest server
 * prefix wins so `github_enterprise_search` belongs to `github_enterprise`
 * when both it and `github` are configured.
 */
export function matchMcpTool(toolName: string, statuses: Readonly<Record<string, string>>): McpToolIdentity | null {
  let best: McpToolIdentity | null = null;
  for (const server of mcpServers(statuses)) {
    const prefix = `${server}${PI_NAME_SEPARATOR}`;
    if (!toolName.startsWith(prefix) || toolName.length === prefix.length) continue;
    if (best === null || server.length > best.server.length) {
      best = { server, tool: toolName.slice(prefix.length) };
    }
  }
  return best;
}

/** The identity the result details carry, which the tool wrote itself and is exact. */
export function mcpIdentityFromDetails(details: unknown): McpToolIdentity | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as { server?: unknown; tool?: unknown };
  if (typeof record.server !== 'string' || typeof record.tool !== 'string') return null;
  return { server: record.server, tool: record.tool };
}

function argumentValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length}]`;
  return '{…}';
}

/** The first few arguments as `key=value`, with a count for the rest. */
export function mcpArgumentSummary(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  const shown = entries.slice(0, MAX_ARGUMENTS).map(([key, value]) => `${key}=${argumentValue(value)}`);
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length}`);
  return shown.join(' · ');
}

export type McpStatusTone = 'running' | 'ok' | 'error' | 'hint';

export interface McpResultView {
  lines: string[];
  status: { glyph: string; tone: McpStatusTone; text: string } | null;
}

/** The result body as renderMcpResult lays it out: text lines, then one status line. */
export function mcpResultView(input: {
  output: string;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}): McpResultView {
  const all = input.output.split('\n');
  while (all.length > 0 && all.at(-1)?.trim() === '') all.pop();
  const lines = input.expanded ? all : all.slice(0, COLLAPSED_RESULT_LINES);

  if (input.isPartial) return { lines, status: { glyph: '◐', tone: 'running', text: 'running' } };
  if (input.isError) return { lines, status: { glyph: '✗', tone: 'error', text: 'failed' } };
  if (!input.expanded && all.length > lines.length) {
    return { lines, status: { glyph: '…', tone: 'hint', text: `${all.length - lines.length} more line(s)` } };
  }
  if (lines.length === 0) return { lines, status: { glyph: '✓', tone: 'ok', text: 'done' } };
  return { lines, status: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One block of the result's details, kept only when its required fields are the strings the adapter wrote. */
function mcpResultBlock(entry: unknown): McpResultBlock | null {
  if (!isRecord(entry)) return null;
  const text = (key: string): string | undefined => (typeof entry[key] === 'string' ? entry[key] : undefined);
  switch (entry.type) {
    case 'audio': {
      const data = text('data');
      const mimeType = text('mimeType');
      return data !== undefined && mimeType !== undefined ? { type: 'audio', data, mimeType } : null;
    }
    case 'resource_link': {
      const uri = text('uri');
      const name = text('name');
      if (uri === undefined || name === undefined) return null;
      const title = text('title');
      const description = text('description');
      const mimeType = text('mimeType');
      return {
        type: 'resource_link',
        uri,
        name,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(mimeType === undefined ? {} : { mimeType }),
      };
    }
    case 'resource': {
      const uri = text('uri');
      if (uri === undefined) return null;
      const mimeType = text('mimeType');
      const content = text('text');
      const blob = text('blob');
      return {
        type: 'resource',
        uri,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(content === undefined ? {} : { text: content }),
        ...(blob === undefined ? {} : { blob }),
      };
    }
    case 'structured':
      return isRecord(entry.value) ? { type: 'structured', value: entry.value } : null;
    default:
      return null;
  }
}

/** The blocks beyond text the adapter attached to the result's details; malformed entries are dropped. */
export function mcpResultBlocks(details: unknown): McpResultBlock[] {
  if (!isRecord(details) || !Array.isArray(details.blocks)) return [];
  return details.blocks.flatMap((entry) => {
    const block = mcpResultBlock(entry);
    return block === null ? [] : [block];
  });
}

export interface McpImageBlock {
  data: string;
  mimeType: string;
}

/** The image blocks of a result's content, which Pi carries beside the text. */
export function mcpImageBlocks(content: readonly unknown[]): McpImageBlock[] {
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'image') return [];
    return typeof block.data === 'string' && typeof block.mimeType === 'string'
      ? [{ data: block.data, mimeType: block.mimeType }]
      : [];
  });
}
