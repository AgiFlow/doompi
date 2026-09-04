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

export const MCP_SESSION_AUTH_STATUS_KEY = 'doom-mcp-session-auth';

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const MAX_SESSION_AUTH_SERVERS = 128;

export interface McpSessionAuthStatusItem {
  readonly name: string;
  readonly state: 'needs-auth';
}

interface McpSessionServerStatusSource {
  readonly name: string;
  readonly state: string;
  readonly [key: string]: unknown;
}

/** Projects only the browser's compact authorization needs, excluding runtime diagnostics and credentials. */
export function formatMcpSessionAuthStatus(servers: readonly McpSessionServerStatusSource[]): string | undefined {
  const items: McpSessionAuthStatusItem[] = servers
    .filter((server) => server.state === 'needs-auth')
    .map((server) => ({ name: server.name, state: 'needs-auth' }));
  return items.length === 0 ? undefined : JSON.stringify(items);
}

/** Reads the live-session status defensively. Empty is the browser's active-session clear value. */
export function parseMcpSessionAuthStatus(raw: string | undefined): McpSessionAuthStatusItem[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const value: unknown = JSON.parse(raw.replace(ANSI_ESCAPE_PATTERN, ''));
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SESSION_AUTH_SERVERS) return undefined;

    const names = new Set<string>();
    for (const item of value) {
      if (!isSessionAuthStatusItem(item) || names.has(item.name)) return undefined;
      names.add(item.name);
    }
    return value;
  } catch {
    return undefined;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) return true;
  }
  return false;
}

function isSessionAuthStatusItem(value: unknown): value is McpSessionAuthStatusItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.name === 'string' &&
    record.name.trim() !== '' &&
    !hasControlCharacter(record.name) &&
    record.state === 'needs-auth'
  );
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
