export type SessionHostReachability = 'reachable' | 'unreachable' | 'unknown';
export type SessionRuntimeState = 'starting' | 'ready' | 'dormant' | 'closing' | 'closed' | 'unknown';
export type SessionActivityState = 'busy' | 'awaiting_input' | 'fully_idle' | 'unknown';
export type SessionVoiceReadiness = 'ready' | 'not_ready' | 'unknown';

export interface SessionPresenceFacts {
  readonly reachability: SessionHostReachability;
  readonly runtime: SessionRuntimeState;
  readonly activity: SessionActivityState;
  readonly voice: {
    readonly eligible: boolean | 'unknown';
    readonly readiness: SessionVoiceReadiness;
  };
}

export interface SessionPresenceObservation extends SessionPresenceFacts {
  readonly hostId: string;
  readonly sessionId: string;
  readonly hostIncarnation: string;
  readonly sessionIncarnation: string;
  readonly sequence: number;
  readonly observedAt: number;
  readonly staleAfterMs: number;
  readonly label?: string;
  readonly deliveryTarget: string;
}

export interface SessionDiscoveryGrant {
  readonly label?: string;
  readonly capabilities: readonly string[];
}

export interface DiscoveredSession extends SessionPresenceFacts {
  readonly reference: string;
  readonly label?: string;
  readonly capabilities: readonly string[];
  readonly hostIncarnation: string;
  readonly sessionIncarnation: string;
  readonly sequence: number;
  readonly observedAt: number;
  readonly freshUntil: number;
  readonly fresh: boolean;
}

export interface SessionDirectoryOptions {
  readonly now?: () => number;
  readonly authorizeDiscovery: (
    callerReference: string,
    subject: Readonly<Pick<SessionPresenceObservation, 'hostId' | 'sessionId' | 'label'>>,
  ) => SessionDiscoveryGrant | undefined;
}

export interface SessionDirectory {
  observe(observation: SessionPresenceObservation): boolean;
  replaceHostSnapshot(
    hostId: string,
    hostIncarnation: string,
    observations: readonly SessionPresenceObservation[],
  ): void;
  hostDisconnected(hostId: string): void;
  discover(callerReference: string, allowedReferences?: ReadonlySet<string>): readonly DiscoveredSession[];
  resolveDeliveryTarget(callerReference: string, reference: string): string | undefined;
  subscribe(callerReference: string, listener: (sessions: readonly DiscoveredSession[]) => void): () => void;
}
