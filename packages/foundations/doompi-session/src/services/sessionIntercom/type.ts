import type { Context } from '@deepseek-ai/cordis';

import type {
  DoomSessionDeliveryMetadata,
  DoomSessionDeliveryService,
  DoomSessionInboxEntry,
  DoomSessionOutboxEntry,
} from '../sessionDelivery';
import type { DiscoveredSession, SessionDirectory } from '../sessionDirectory';
import type { SessionGroupStore } from '../sessionGroups';

export const DOOM_SESSION_INTERCOM_SERVICE = 'doom/session-intercom';

export type SessionReportStatus = 'done' | 'blocked' | 'failed';

export interface SessionIntercomMessage {
  readonly deliveryId: string;
  readonly sourceReference: string;
  readonly targetReference: string;
  readonly groupId: string;
  readonly correlationId?: string;
  readonly text: string;
  readonly reportStatus?: SessionReportStatus;
  readonly state: DoomSessionInboxEntry['state'];
  readonly consumed: boolean;
}

export interface SessionIntercomSendRequest {
  readonly targetReference: string;
  readonly groupId: string;
  readonly text: string;
  readonly correlationId?: string;
  readonly deliveryId?: string;
}

export interface SessionIntercomOptions {
  readonly selfReference: string;
  readonly directory: SessionDirectory;
  readonly groups: SessionGroupStore;
  readonly delivery: DoomSessionDeliveryService;
}

export interface SessionIntercom {
  discover(): readonly DiscoveredSession[];
  send(request: SessionIntercomSendRequest): Promise<{ deliveryId: string }>;
  report(
    request: SessionIntercomSendRequest & { readonly status: SessionReportStatus },
  ): Promise<{ deliveryId: string }>;
  messages(): readonly SessionIntercomMessage[];
  delivery(deliveryId: string): DoomSessionOutboxEntry | undefined;
}

export interface SessionGroupDeliveryAuthorizationOptions {
  readonly selfReference: string;
  readonly groups: SessionGroupStore;
  readonly peerReference: (peerKey: string) => string | undefined;
  readonly fallback?: (peerKey: string, metadata: DoomSessionDeliveryMetadata | undefined) => boolean;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/session-intercom': SessionIntercom;
  }
}

export function readSessionIntercom(context: Context): SessionIntercom | undefined {
  return context.get(DOOM_SESSION_INTERCOM_SERVICE) as SessionIntercom | undefined;
}

export function requireSessionIntercom(context: Context): SessionIntercom {
  const service = readSessionIntercom(context);
  if (!service)
    throw new Error('Session intercom is unavailable. Activate Session with a configured persistent host identity.');
  return service;
}
