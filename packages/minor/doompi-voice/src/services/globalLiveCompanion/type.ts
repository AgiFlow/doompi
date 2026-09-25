import type { DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-core/hubChannel';

import type { RealtimeDeliveryOutcome } from '../../types/realtime';

export interface LiveAgentRoute {
  scope: DoomHubSessionScope;
  sessionIncarnation: string;
  activationId: string;
  generation: number;
  transactionId: string;
  cursor: number;
}

export interface LiveAgentResult {
  sequence: number;
  requestIds: string[];
  runId: string;
  turnId?: string;
  resultId: string;
  assistantText?: string;
  status: 'completed' | 'aborted' | 'failed';
  sourceSessionId: string;
  sessionIncarnation: string;
}

export interface LiveAgentResults {
  cursor: number;
  activeRuns: { runId: string; lane?: string }[];
  events: LiveAgentResult[];
}

/** The only host capability that can address another admitted local agent. */
export type GlobalLiveAgentHost = Pick<DoomHubChannelHost, 'sessions' | 'requestSessionApi' | 'onNotice'>;

/** Existing native history is the authority after an arbitrary provider ID leaves the hot cache. */
export interface GlobalLiveReceipts {
  reserve(input: {
    namespace: string;
    activationId: string;
    requestId: string;
    fingerprint: string;
    destination: string;
    transactionId: string;
  }): Promise<
    | { kind: 'reserved'; token: string }
    | { kind: 'existing'; receipt: { outcome: 'reserved' | 'admitted' | 'rejected' | 'uncertain' } }
    | { kind: 'conflict'; receipt: { outcome: 'reserved' | 'admitted' | 'rejected' | 'uncertain' } }
  >;
  finish(input: {
    namespace: string;
    activationId: string;
    requestId: string;
    token: string;
    outcome: 'admitted' | 'rejected' | 'uncertain';
  }): Promise<{ outcome: 'reserved' | 'admitted' | 'rejected' | 'uncertain' }>;
}

export interface GlobalLiveControl {
  action: 'activate' | 'end' | 'mute' | 'unmute' | 'interrupt';
  sessionId?: string;
}

export interface GlobalLiveStatus {
  version: 1;
  state: 'disabled' | 'starting' | 'active' | 'draining' | 'shuttingDown';
  activeSessionId: string | null;
  muted: boolean;
  error?: string;
  media: { client: boolean; realtime: boolean };
}

export type GlobalLiveAdmission = (requestId: string, transcript: string) => Promise<RealtimeDeliveryOutcome>;
