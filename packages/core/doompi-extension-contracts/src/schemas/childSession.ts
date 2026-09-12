import type { Context } from '@deepseek-ai/cordis';

export const DOOM_CHILD_SESSION_SERVICE = 'doom/child-session';

export type DoomChildSessionState = 'starting' | 'running' | 'completed' | 'failed' | 'stopped';

export interface DoomChildSessionFreshSource {
  readonly kind: 'fresh';
}

/** Continue one previously-owned native child journal. Providers must validate the v4 header before opening it. */
export interface DoomChildSessionV4RestoreSource {
  readonly kind: 'v4-restore';
  readonly sessionFile: string;
}

/** Fork one branch of a headless v4 journal into a separate child journal. */
export interface DoomChildSessionV4ForkSource {
  readonly kind: 'v4-fork';
  readonly sessionFile: string;
  readonly branch: string;
  readonly entryId?: string;
}

/**
 * Immutable terminal Pi branch captured by the thin Pi adapter.
 *
 * The serialized v3 snapshot is data, not a writable parent path. The child host
 * converts it into a separate v4 journal and never opens the active Pi history.
 */
export interface DoomChildSessionTerminalPiForkSource {
  readonly kind: 'terminal-pi-fork';
  readonly sourceSessionId: string;
  readonly sourceLeafId: string;
  readonly snapshotJsonl: string;
}

export type DoomChildSessionSource =
  | DoomChildSessionFreshSource
  | DoomChildSessionV4RestoreSource
  | DoomChildSessionV4ForkSource
  | DoomChildSessionTerminalPiForkSource;

export interface DoomChildSessionScope {
  readonly rootSessionId: string;
  readonly scopeKey: string;
}

/** Capability data is intentionally host-neutral; the owning runtime validates its fields. */
export interface DoomChildSessionCapabilityCeiling {
  readonly allowedTools?: readonly string[];
  readonly requiredTools?: readonly string[];
  readonly allowMcpTools?: boolean;
  readonly allowedExternalProfiles?: readonly string[];
  readonly denyExtensions?: boolean;
}

export interface DoomChildSessionRequest {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly scope: DoomChildSessionScope;
  readonly source: DoomChildSessionSource;
  readonly agent: string;
  readonly task: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly systemPrompt?: string;
  readonly systemPromptMode?: 'append' | 'replace';
  readonly extensions?: readonly string[];
  readonly subagentOnlyExtensions?: readonly string[];
  readonly tools?: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly skills?: readonly string[];
  readonly mcpDirectTools?: readonly string[];
  readonly capabilityCeiling?: DoomChildSessionCapabilityCeiling;
  readonly intercom?: DoomChildSessionIntercom;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface DoomChildSessionEvent {
  readonly runId: string;
  readonly state: DoomChildSessionState;
  readonly timestamp: number;
  readonly message?: string;
  readonly sessionFile?: string;
}

export interface DoomChildSessionToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface DoomChildSessionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    operationId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (result: DoomChildSessionToolResult) => void,
  ): Promise<DoomChildSessionToolResult>;
}

/** Direct in-process Team intercom supplied by an owning extension. */
export interface DoomChildSessionIntercom {
  bindRuntime(runtime: DoomChildSessionRuntime): DoomChildSessionTool;
  dispose?(): void;
}

/** Host runtime owned by the direct headless or terminal adapter. */
export interface DoomChildSessionRuntime {
  readonly sessionId: string;
  readonly sessionFile?: string;
  prompt(task: string): Promise<string | void>;
  steer(message: string): Promise<void>;
  followUp?(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export type DoomChildSessionRuntimeFactory = (
  request: DoomChildSessionRequest,
  signal?: AbortSignal,
) => Promise<DoomChildSessionRuntime>;

export interface DoomChildSessionHandle {
  readonly runId: string;
  readonly sessionFile?: string;
  state(): DoomChildSessionState;
  subscribe(listener: (event: DoomChildSessionEvent) => void): () => void;
  steer(message: string, signal?: AbortSignal): Promise<void>;
  stop(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface DoomChildSessionService {
  start(request: DoomChildSessionRequest, signal?: AbortSignal): Promise<DoomChildSessionHandle>;
  get(runId: string): DoomChildSessionHandle | undefined;
  close(): Promise<void>;
}

/** Lazy provider lets Pi and headless composition bind the host-owned service later. */
export interface DoomChildSessionServiceProvider {
  get(): DoomChildSessionService | undefined;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/child-session': DoomChildSessionService;
  }
}

export function readDoomChildSessionService(context: Context): DoomChildSessionService | undefined {
  return context.get(DOOM_CHILD_SESSION_SERVICE) as DoomChildSessionService | undefined;
}

export function requireDoomChildSessionService(context: Context): DoomChildSessionService {
  const service = readDoomChildSessionService(context);
  if (!service) throw new Error('The Doom child-session service is unavailable.');
  return service;
}
