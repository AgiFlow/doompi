/**
 * What an MCP tool result carries beyond its text, shared by this package's
 * Pi adapter (which attaches it as the result's details) and its web plugin
 * (which renders it). Wire JSON only: images ride Pi's own content blocks,
 * so they are not repeated here.
 */

export type McpResultBlock =
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  | { type: 'structured'; value: Record<string, unknown> };

export interface McpToolDetails {
  server: string;
  tool: string;
  /** Present only when the downstream result carried something beyond text and images. */
  blocks?: McpResultBlock[];
}

/** Hub API paths for repository-scoped MCP management. */
export const MCP_REPOSITORY_API_PATH = '/repository';
export const MCP_DISCOVERY_API_PATH = '/repository/discover';
export const MCP_AUTHORIZATION_API_PATH = '/repository/authorize';

export type McpRepositoryServerState =
  | 'not-connected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'needs-auth'
  | 'failed'
  | 'closed';

export interface McpRepositoryTool {
  name: string;
  piName: string;
  description?: string;
}

export interface McpRepositoryServer {
  name: string;
  state: McpRepositoryServerState;
  source: 'cached' | 'live' | 'configured';
  credentialPresent: boolean;
  tools: McpRepositoryTool[];
  error?: string;
}

export interface McpRepositoryCatalog {
  repositoryId: string;
  sync: {
    fresh: boolean;
    reasons: string[];
  };
  servers: McpRepositoryServer[];
  droppedServers: string[];
  diagnostics: string[];
}

export type McpAuthorizationStatus = 'starting' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface McpAuthorizationFlow {
  id: string;
  repositoryId: string;
  serverName: string;
  status: McpAuthorizationStatus;
  authorizationUrl?: string;
  error?: string;
  expiresAt: number;
}
