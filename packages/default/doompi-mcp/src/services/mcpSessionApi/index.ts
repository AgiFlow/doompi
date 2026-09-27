import type { DoomApi } from '@agimon-ai/doompi-core/packageApi';

import {
  MCP_SESSION_TOOL_API_PATH,
  MCP_SESSION_TOOL_NAME_QUERY,
  MCP_SESSION_TOOL_SERVER_QUERY,
  type McpSessionToolDetail,
} from '../../types/webMcp';
import type { CatalogTool } from '../mcpCatalog';
import { type CountTokens, mcpToolTokens } from '../mcpToolCost';

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export interface McpSessionApiSource {
  /** The tools `mcp_use` accepts right now. */
  activeToolDefinitions(): readonly CatalogTool[];
}

/**
 * This package's session mount, `mcp-session`: one reachable tool's description and schema.
 *
 * Read-only and bounded to the tools `mcp_use` accepts, so a page can inspect what the agent may
 * call without the status line carrying every schema.
 */
export function createMcpSessionApi(source: McpSessionApiSource, countTokens: () => Promise<CountTokens>): DoomApi {
  return {
    basePath: 'mcp-session',
    start() {
      return {
        async fetch(request) {
          const url = new URL(request.url);
          if (request.method !== 'GET' || url.pathname !== MCP_SESSION_TOOL_API_PATH)
            return json({ error: 'Not found.' }, 404);
          const server = url.searchParams.get(MCP_SESSION_TOOL_SERVER_QUERY) ?? '';
          const name = url.searchParams.get(MCP_SESSION_TOOL_NAME_QUERY) ?? '';
          if (!server || !name) return json({ error: 'A tool is named by its server and tool name.' }, 400);
          const tool = source
            .activeToolDefinitions()
            .find((candidate) => candidate.serverName === server && candidate.toolName === name);
          if (!tool) return json({ error: `MCP tool ${server}/${name} is not available in this session.` }, 404);
          const detail: McpSessionToolDetail = {
            server,
            tool: name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            tokens: mcpToolTokens(tool, await countTokens()),
          };
          return json(detail);
        },
        // Nothing outlives a request here.
        close: () => undefined,
      };
    },
  };
}
