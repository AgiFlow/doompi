export type SessionMcpCallStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/** Host-only activity data. Never part of the remote agent's conversation or tool context. */
export interface SessionMcpCall {
  sequence: number;
  id: string;
  toolName: string;
  clientName: string;
  startedAt: number;
  finishedAt?: number;
  status: SessionMcpCallStatus;
  input: string;
  output?: string;
}

export interface SessionMcpAvailableTool {
  name: string;
  label: string;
  description: string;
  inputSchema: object;
  connections: string[];
}

export interface SessionMcpActivitySnapshot {
  enabled: boolean;
  available: boolean;
  /** Internal names. Remote names are `${toolPrefix}_${name}` when toolPrefix is set. */
  tools: SessionMcpAvailableTool[];
  toolPrefix?: string;
  calls: SessionMcpCall[];
  total: number;
  nextBefore?: number;
}

/** Internal lifecycle event. Authentication credentials and transport metadata are deliberately absent. */
export interface SessionMcpInvocation {
  id: string;
  parentSessionId: string;
  sessionId?: string;
  clientId: string;
  conversationDigest?: string;
  toolName: string;
  startedAt: number;
  finishedAt?: number;
  status: SessionMcpCallStatus;
  input: unknown;
  output?: unknown;
}
