/** Browser-facing contract for one session's host-managed MCP clients. */
export type SessionMcpScope = 'restricted' | 'session';
export type SessionMcpRouting = 'conversation';
export interface SessionMcpTool {
  name: string;
  label: string;
  description: string;
}

export interface SessionMcpSkill {
  name: string;
  description: string;
  uri: string;
}

export interface SessionMcpConfig {
  audience: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  tools: SessionMcpTool[];
  skills: SessionMcpSkill[];
}

export interface SessionMcpClient {
  clientId: string;
  name: string;
  redirectUri: string;
  tokenEndpointAuthMethod: 'client_secret_post' | 'api_key' | 'url_token';
  createdAt: number;
  scope: SessionMcpScope;
  routing: SessionMcpRouting;
  tools: string[];
  skills: string[];
  audience: string;
}

export interface CreatedSessionMcpClient extends SessionMcpClient {
  /** One-time credential material. Signed URL clients receive only connectionUrl. */
  clientSecret?: string;
  connectionUrl?: string;
}

export type CreateSessionMcpClientInput =
  | { redirectUri: string; scope: 'session'; routing: SessionMcpRouting }
  | { authMethod: 'api_key' | 'url_token'; scope: 'session'; routing: SessionMcpRouting };
