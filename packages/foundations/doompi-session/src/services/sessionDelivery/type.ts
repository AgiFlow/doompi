import type { DoomSessionCommunicationEndpoint } from '@agimon-ai/doompi-core/hub-channel';
import type { Context } from '@deepseek-ai/cordis';

export const DOOM_SESSION_DELIVERY_SERVICE = 'doom/session-delivery';

export type DoomSessionDeliveryInboxState = 'accepted' | 'admitting' | 'admitted' | 'recovery_required';
export type DoomSessionDeliveryMode = 'prompt' | 'steer' | 'followUp';

export interface DoomSessionDeliveryMetadata extends Readonly<Record<string, string | undefined>> {
  readonly worktreeId?: string;
  readonly fromRole?: string;
}

export interface DoomSessionDeliveryRequest {
  readonly deliveryId?: string;
  readonly recipientKey: string;
  readonly kind: string;
  readonly prompt: string;
  readonly delivery?: DoomSessionDeliveryMode;
  readonly metadata?: DoomSessionDeliveryMetadata;
}

export interface DoomSessionInboxQuery {
  readonly kind?: string;
  readonly metadata?: DoomSessionDeliveryMetadata;
  readonly state?: DoomSessionDeliveryInboxState;
  readonly consumed?: boolean;
}

export interface DoomSessionInboxEntry {
  readonly deliveryId: string;
  readonly senderKey: string;
  readonly recipientKey: string;
  readonly kind: string;
  readonly prompt: string;
  readonly delivery: DoomSessionDeliveryMode;
  readonly metadata: DoomSessionDeliveryMetadata;
  readonly state: DoomSessionDeliveryInboxState;
  readonly consumed: boolean;
}

export interface DoomSessionOutboxEntry {
  readonly deliveryId: string;
  readonly recipientKey: string;
  readonly kind: string;
  readonly state: 'queued' | 'acknowledged';
  readonly recipientState?: DoomSessionDeliveryInboxState;
}

export interface DoomSessionDeliveryService {
  readonly recipientKey: string;
  deliver(request: DoomSessionDeliveryRequest): Promise<{ deliveryId: string }>;
  waitForAdmission(deliveryId: string, timeoutMs?: number): Promise<DoomSessionDeliveryInboxState | undefined>;
  inbox(query?: DoomSessionInboxQuery): readonly DoomSessionInboxEntry[];
  /** Host-routed authenticated peer envelope admission. Not a composition control surface. */
  receive(senderKey: string, kind: string, payload: unknown): DoomSessionDeliveryInboxState | undefined;
  consume(deliveryId: string): boolean;
  outbox(deliveryId: string): DoomSessionOutboxEntry | undefined;
  close(): Promise<void>;
}

export interface SessionDeliveryServiceOptions {
  readonly databasePath: string;
  readonly recipientKey: string;
  readonly communication: DoomSessionCommunicationEndpoint;
  /** Host-owned relationship check applied to both outbound recipients and inbound senders. */
  readonly authorizePeer: (peerKey: string) => boolean;
  readonly admitPrompt: (prompt: string, delivery?: DoomSessionDeliveryMode) => Promise<void>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'doom/session-delivery': DoomSessionDeliveryService;
  }
}

/** Reads the currently active provider each time, without retaining a stale binding. */
export function readDoomSessionDelivery(context: Context): DoomSessionDeliveryService | undefined {
  return context.get(DOOM_SESSION_DELIVERY_SERVICE) as DoomSessionDeliveryService | undefined;
}
