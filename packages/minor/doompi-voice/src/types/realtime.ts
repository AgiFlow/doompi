/** Host-only subscription credentials. Never serialize these to media clients or diagnostics. */
export interface RealtimeCredentials {
  accessToken: string;
  accountId: string;
}

export interface RealtimeAuth {
  credentials(signal: AbortSignal): Promise<RealtimeCredentials>;
  refresh(signal: AbortSignal): Promise<RealtimeCredentials>;
}

export interface RealtimeCallRequest {
  sdp: string;
  instructions: string;
}

export interface RealtimeCall {
  sdp: string;
  callId: string;
}

export interface RealtimeProvider {
  createCall(request: RealtimeCallRequest, signal: AbortSignal): Promise<RealtimeCall>;
}

export type RealtimeEvent =
  | { type: 'ready' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; complete: boolean }
  | { type: 'request'; requestId: string; text: string }
  | { type: 'error'; code: string };

export type RealtimeDeliveryOutcome = 'submitted' | 'busy' | 'uncertain' | 'rejected';

export interface RealtimeActionRequest {
  activationId: string;
  requestId: string;
  text: string;
}

export interface RealtimeBrowserState {
  connection: 'connecting' | 'connected' | 'closed' | 'failed';
  listening: boolean;
  speaking: boolean;
  muted: boolean;
  error?: string;
}

export interface BrowserRealtimeOptions {
  negotiate(sdp: string, signal: AbortSignal): Promise<string>;
  onEvent(event: string): void;
  onState(state: RealtimeBrowserState): void;
}

export const REALTIME_LIMITS = {
  sdpBytes: 65_536,
  eventBytes: 65_536,
  instructionsCharacters: 16_384,
  textCharacters: 8_192,
  identifierCharacters: 256,
  pendingRequests: 1,
  retainedRequests: 128,
} as const;

export const REALTIME_ROUTES = {
  hostStart: '/host/realtime/start',
  hostStop: '/host/realtime/stop',
  hostPoll: '/host/realtime/poll',
  hostSend: '/host/realtime/send',
  hostControl: '/host/realtime/control',
  clientNegotiate: '/client/realtime/negotiate',
  clientEvent: '/client/realtime/event',
  clientState: '/client/realtime/state',
} as const;

export type RealtimeControl = 'mute' | 'unmute' | 'interrupt';

export type RealtimeMediaCommand =
  | { sequence: number; type: 'realtime-start'; activationId: string }
  | { sequence: number; type: 'realtime-stop'; activationId: string }
  | { sequence: number; type: 'realtime-control'; activationId: string; action: RealtimeControl }
  | { sequence: number; type: 'realtime-send'; activationId: string; messages: string[] };

export interface RealtimeHostSnapshot {
  activationId: string;
  state: 'connecting' | 'active' | 'closed' | 'failed';
  cursor: number;
  events: { sequence: number; event: RealtimeEvent }[];
  browser?: RealtimeBrowserState;
}

/** All methods use the existing authenticated media transport and current connection lease. */
export interface RealtimeMediaTransport {
  realtimeNegotiate(
    clientId: string,
    connectionId: string,
    activationId: string,
    sdp: string,
    signal: AbortSignal,
  ): Promise<string>;
  realtimeEvent(clientId: string, connectionId: string, activationId: string, event: string): Promise<void>;
  realtimeState(
    clientId: string,
    connectionId: string,
    activationId: string,
    state: RealtimeBrowserState,
  ): Promise<void>;
}
