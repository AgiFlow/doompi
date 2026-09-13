export interface DoomHubChannelFrame {
  type: string;
  sessionId: string;
  payload: unknown;
}

/** Same-process lifecycle bus shared by a host's session APIs and hub channels. */
export interface DoomDirectEventSubscriptionOptions {
  /** Replay the most recent value published for this frame and session, when one exists. */
  readonly replayLatest?: boolean;
}

export interface DoomDirectEventBus {
  publish(frameType: string, sessionId: string, payload: unknown): void;
  subscribe(
    frameType: string,
    sessionId: string,
    listener: (payload: unknown) => void,
    options?: DoomDirectEventSubscriptionOptions,
  ): () => void;
  /** Drop retained state for a session after its lifecycle ends. */
  clearSession?(sessionId: string): void;
  close(): void;
}

export interface DoomHubSessionScope {
  sessionId: string;
  workspaceId?: string;
  cwd: string;
  /** Environment admitted for this session, when supplied by the host. */
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface DoomHubSessionCreateRequest {
  readonly cwd: string;
  readonly name: string;
  readonly parentSessionId?: string;
  readonly sessionProvenance?: string;
  readonly signal?: AbortSignal;
}

/** Direct lifecycle owned by the canonical headless hub, never by a package transport. */
export interface DoomHubSessionService {
  create(request: DoomHubSessionCreateRequest): Promise<DoomHubSessionScope>;
  close(sessionId: string): Promise<void>;
  isLive(sessionId: string): boolean;
}

export interface DoomHubSessionApiRequest {
  basePath: string;
  path: string;
  method: string;
  body?: string | Uint8Array<ArrayBuffer> | null;
  signal?: AbortSignal;
  /** Forwarded by the authenticated host, including content type and trace context. */
  headers?: RequestInit['headers'];
}

export type DoomComputerUseHostOperation = 'status' | 'targets' | 'activate' | 'observe' | 'act' | 'stop';

export interface DoomComputerUseHostRequest {
  readonly operation: DoomComputerUseHostOperation;
  readonly payload?: unknown;
  readonly signal?: AbortSignal;
}

export interface DoomComputerUseHostBinding {
  readonly available: boolean;
  request(scope: DoomHubSessionScope, request: DoomComputerUseHostRequest): Promise<unknown>;
  close?(): void;
}

export interface DoomHubChannelConnection {
  connectionId: string;
}

export interface DoomHubChannelHost {
  sessions(): readonly DoomHubSessionScope[];
  /** Canonical hub lifecycle for sessions created by channel commands. */
  sessionService?: DoomHubSessionService;
  /** Same-process events emitted by session facets. */
  readonly directEvents: DoomDirectEventBus;
  publish(sessionId: string, payload: unknown): void;
  publishToConnection?(connectionId: string, sessionId: string, payload: unknown): boolean;
  requestSessionApi(scope: DoomHubSessionScope, request: DoomHubSessionApiRequest): Promise<Response>;
  computerUse?: DoomComputerUseHostBinding;
  onNotice(message: string): void;
}

export interface DoomHubChannelSource {
  payloadFor(scope: DoomHubSessionScope): unknown;
  sessionAdded?(scope: DoomHubSessionScope): void;
  sessionRemoved?(sessionId: string): void;
  threadJournal?(scope: DoomHubSessionScope, threadId: string): string | undefined;
  close(): void;
}

export type DoomHubChannelLifecycle = 'session' | 'hub';

export interface DoomHubChannel {
  frameType: string;
  lifecycle?: DoomHubChannelLifecycle;
  start(host: DoomHubChannelHost): DoomHubChannelSource;
  receiveWithoutSubscription?: boolean;
  receive?(scope: DoomHubSessionScope, payload: unknown, connection: DoomHubChannelConnection): void;
  disconnected?(connection: DoomHubChannelConnection): void;
}
