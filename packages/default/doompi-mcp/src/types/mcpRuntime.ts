import type { McpToolInfo } from '@agimon-ai/mcp-proxy';

export interface CatalogServer {
  name: string;
  tools: McpToolInfo[];
}

/** Server definitions from the previous run, available before any socket opens. */
export interface CachedCatalog {
  servers: CatalogServer[];
}
