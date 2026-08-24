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
