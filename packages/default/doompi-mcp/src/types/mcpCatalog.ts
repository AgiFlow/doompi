import type { McpServerSnapshot, McpStatusSnapshot } from '@agimon-ai/doompi-extension-contracts/mcp-status';

export interface McpCatalogToolInput {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCatalogStateChange {
  serverName: string;
  state: McpServerSnapshot['state'];
  error?: string;
}

export type McpCatalogState = McpServerSnapshot['state'];
export type McpCatalogSnapshot = McpStatusSnapshot;
