import type { DoomSessionDeliveryInboxState } from '../sessionDelivery';

export type SessionPeerInbox = (
  sourceKey: string,
  type: string,
  payload: unknown,
) => DoomSessionDeliveryInboxState | undefined;

const inboxes = new Map<string, SessionPeerInbox>();

/** Registers one live session-owned peer inbox. This registry is reachable only by the Session route. */
export function registerSessionPeerInbox(sessionId: string, inbox: SessionPeerInbox): () => void {
  if (inboxes.has(sessionId)) throw new Error(`Session peer inbox '${sessionId}' is already registered.`);
  inboxes.set(sessionId, inbox);
  return () => {
    if (inboxes.get(sessionId) === inbox) inboxes.delete(sessionId);
  };
}

export function deliverSessionPeerEnvelope(
  targetSessionId: string,
  sourceKey: string,
  type: string,
  payload: unknown,
): DoomSessionDeliveryInboxState | undefined {
  return inboxes.get(targetSessionId)?.(sourceKey, type, payload);
}
