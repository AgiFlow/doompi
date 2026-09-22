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
  tokenEndpointAuthMethod: 'client_secret_post';
  createdAt: number;
  scope: SessionMcpScope;
  routing: SessionMcpRouting;
  tools: string[];
  skills: string[];
  audience: string;
}

export interface CreatedSessionMcpClient extends SessionMcpClient {
  /** Returned once by the host and never included in later list responses. */
  clientSecret: string;
}

export interface CreateSessionMcpClientInput {
  redirectUri: string;
  scope: 'session';
  routing: SessionMcpRouting;
}
