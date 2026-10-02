/**
 * What an MCP tool result carries beyond its text, shared by this package's
 * Pi adapter (which attaches it as the result's details) and its web plugin
 * (which renders it). Wire JSON only: images ride Pi's own content blocks,
 * so they are not repeated here.
 */
import type { ContextToolWarning } from '@agimon-ai/doompi-core/contextApi';
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
const MAX_AUTHORIZATION_URL_LENGTH = 8192;
const MAX_SERVER_TOOLS = 512;
const MAX_TOOL_NAME_LENGTH = 256;
const SESSION_AUTH_STATES = [
  'not-connected',
  'connecting',
  'connected',
  'degraded',
  'needs-auth',
  'failed',
  'closed',
  'disabled',
] as const;
export type McpSessionAuthState = (typeof SESSION_AUTH_STATES)[number];

function isSessionAuthState(value: unknown): value is McpSessionAuthState {
  return SESSION_AUTH_STATES.some((state) => state === value);
}

export interface McpSessionAuthStatusItem {
  readonly name: string;
  readonly state: McpSessionAuthState;
  readonly authorizationUrl?: string;
  /** Available tools and their estimated direct-schema cost, not a second context inventory. */
  readonly tools?: readonly McpSessionReachableTool[];
}

export interface McpSessionReachableTool {
  /** Original downstream name, used with the configured server for detail lookup. */
  readonly name: string;
  /** Actual registered name. Optional for older live-session status producers. */
  readonly piName?: string;
  readonly tokens?: number;
}

/** A session's view of one reachable tool: what the dialog shows when a row is opened. */
export interface McpSessionToolDetail {
  readonly server: string;
  readonly tool: string;
  readonly piName: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tokens: number;
  readonly warnings?: readonly ContextToolWarning[];
}

/** Session route for one reachable tool's description and schema. */
export const MCP_SESSION_TOOL_API_PATH = '/tool';
export const MCP_SESSION_TOOL_SERVER_QUERY = 'server';
export const MCP_SESSION_TOOL_NAME_QUERY = 'tool';

interface McpSessionServerStatusSource {
  readonly name: string;
  readonly state: string;
  readonly authorizationUrl?: unknown;
  readonly tools?: readonly {
    readonly toolName: string;
    readonly piName?: string;
    readonly active: boolean;
    readonly tokens?: number;
  }[];
}

/** Keeps servers visible before discovery and after failures, without diagnostics or credentials. */
export function formatMcpSessionAuthStatus<T extends McpSessionServerStatusSource>(
  servers: readonly T[],
): string | undefined {
  const items: McpSessionAuthStatusItem[] = servers.flatMap((server) => {
    if (!isSessionAuthState(server.state)) return [];
    const tools = (server.tools ?? [])
      .filter((tool) => tool.active && isToolName(tool.toolName))
      .map((tool): McpSessionReachableTool => ({
        name: tool.toolName,
        ...(isToolName(tool.piName) ? { piName: tool.piName } : {}),
        ...(isTokenCount(tool.tokens) ? { tokens: tool.tokens } : {}),
      }))
      .slice(0, MAX_SERVER_TOOLS);
    const item: McpSessionAuthStatusItem = {
      name: server.name,
      state: server.state,
      ...(isAuthorizationUrl(server.authorizationUrl) ? { authorizationUrl: server.authorizationUrl } : {}),
      ...(tools.length === 0 ? {} : { tools }),
    };
    return [item];
  });
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
    if (codePoint !== undefined && (codePoint < 32 || (codePoint >= 127 && codePoint <= 159))) return true;
  }
  return false;
}

function isAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_AUTHORIZATION_URL_LENGTH || hasControlCharacter(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_TOOL_NAME_LENGTH &&
    !hasControlCharacter(value)
  );
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isReachableTool(value: unknown): value is McpSessionReachableTool {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === 'name' || key === 'piName' || key === 'tokens') &&
    isToolName(record.name) &&
    (!('piName' in record) || isToolName(record.piName)) &&
    (!('tokens' in record) || isTokenCount(record.tokens))
  );
}

function isSessionAuthStatusItem(value: unknown): value is McpSessionAuthStatusItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(
      (key) => key === 'name' || key === 'state' || key === 'authorizationUrl' || key === 'tools',
    ) &&
    (!('authorizationUrl' in record) || isAuthorizationUrl(record.authorizationUrl)) &&
    (!('tools' in record) ||
      (Array.isArray(record.tools) &&
        record.tools.length <= MAX_SERVER_TOOLS &&
        record.tools.every(isReachableTool))) &&
    typeof record.name === 'string' &&
    record.name.trim() !== '' &&
    !hasControlCharacter(record.name) &&
    isSessionAuthState(record.state)
  );
}

/** Hub API paths for repository-scoped MCP management. */
export const MCP_REPOSITORY_API_PATH = '/repository';
export const MCP_DISCOVERY_API_PATH = '/repository/discover';
export const MCP_AUTHORIZATION_API_PATH = '/repository/authorize';
/** The repository every route is asked about, and the flow segment the two flow routes carry. */
export const MCP_REPOSITORY_ID_QUERY = 'repositoryId';
export const MCP_FLOW_ID_PARAM = 'flowId';

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
