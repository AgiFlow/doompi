import type { McpServerSnapshot, McpStatusSnapshot } from '@agimon-ai/doompi-core/mcp-status';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpCatalogToolInput {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Tool['annotations'];
  outputSchema?: Tool['outputSchema'];
}

export interface McpCatalogStateChange {
  serverName: string;
  state: McpServerSnapshot['state'];
  error?: string;
}

export type McpCatalogState = McpServerSnapshot['state'];
export type McpCatalogSnapshot = McpStatusSnapshot;
