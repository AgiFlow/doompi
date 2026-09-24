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

export interface DoomHubReservedWorktreeRequest {
  readonly reservationId: string;
  readonly parentSessionId: string;
  readonly signal?: AbortSignal;
}

export type DoomHubReservedWorktreeProvisioner = (
  request: DoomHubReservedWorktreeRequest,
) => Promise<DoomHubSessionScope>;

export interface DoomHubSessionCreateRequest {
  readonly cwd: string;
  readonly name: string;
  readonly parentSessionId?: string;
  readonly sessionProvenance?: string;
  readonly signal?: AbortSignal;
  /** Host-issued reservation, not a caller-chosen target session id. */
  readonly reservationId?: string;
}

/** Host-bound inter-session events. The source identity is attached by the hub, never by payload data. */
export interface DoomSessionCommunicationEndpoint {
  readonly sessionId: string;
  publish(targetSessionId: string, type: string, payload: unknown): boolean;
  subscribe(type: string, listener: (sourceSessionId: string, payload: unknown) => void): () => void;
  onPeerReady(listener: (peerSessionId: string) => void): () => void;
  close(): void;
}
export interface DoomPendingSessionSetup {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly cwd?: string;
}

/** A host-owned setup can be fulfilled by any execution-directory provider. */
export interface DoomHubSessionReservations {
  read(id: string, parentSessionId: string): { sessionId: string; cwd?: string };
  prepare(id: string, parentSessionId: string, cwd: string): Promise<{ sessionId: string; cwd: string }>;
  complete(id: string, parentSessionId: string): Promise<DoomHubSessionScope>;
}

/** Direct lifecycle owned by the canonical headless hub, never by a package transport. */
export interface DoomHubSessionService {
  create(request: DoomHubSessionCreateRequest): Promise<DoomHubSessionScope>;
  close(sessionId: string): Promise<void>;
  isLive(sessionId: string): boolean;
  readonly reservations?: DoomHubSessionReservations;
  /** Provisions a host-reserved Git worktree child. This is not exposed to remote MCP clients. */
  provisionReservedWorktree?(request: DoomHubReservedWorktreeRequest): Promise<DoomHubSessionScope>;
  /** Core host hook. A Git provider registers its implementation while its channel is mounted. */
  registerReservedWorktreeProvisioner?(provisioner: DoomHubReservedWorktreeProvisioner): () => void;
  /** True only when both live sessions have a direct parent-child relationship. */
  canCommunicate?(sourceSessionId: string, targetSessionId: string): boolean;
  /** Core host hook. Session API construction removes this method before exposing the service to extensions. */
  bindCommunication?(sessionId: string): DoomSessionCommunicationEndpoint;
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
  /** Global opt-in, separate from the presence of a native host. */
  readonly enabled?: boolean;
  request(scope: DoomHubSessionScope, request: DoomComputerUseHostRequest): Promise<unknown>;
  /** Checks a proof injected by the owning Desktop process, never a renderer marker. */
  authorize?(headers: Headers): boolean;
  /** Pins a session to Desktop before asking for a native grant. Ownership is not persisted. */
  claimSession?(sessionId: string): void;
  ownsSession?(sessionId: string): boolean;
  forgetSession?(sessionId: string): void;
  subscribe?(listener: () => void): () => void;
  close?(): void;
}

/** Narrow, host-bound access. An extension cannot select another session's identity. */
export interface DoomComputerUseSessionAccess {
  readonly available: boolean;
  readonly enabled?: boolean;
  authorize(headers: Headers): boolean;
  claim(): void;
  subscribe(listener: () => void): () => void;
}

export interface DoomHubChannelConnection {
  connectionId: string;
  /** Host-verified native renderer proof, never copied from a channel payload. */
  desktopAuthorized?: boolean;
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
