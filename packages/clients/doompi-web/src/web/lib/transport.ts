import { sessionCommand } from '../../types/hub.ts';

type Frame = Record<string, unknown>;

let send: ((frame: object) => void) | undefined;

/**
 * Holds the live socket sender.
 *
 * The socket is owned by the composition root but commands are issued from
 * feature code, and this keeps that one indirection explicit instead of
 * threading a sender through every component.
 */
export function bindTransport(sender: (frame: object) => void): void {
  send = sender;
}

export function releaseTransport(): void {
  send = undefined;
}

/** Sends one command frame to a session's agent, enveloped for the hub. */
export function sendFrame(sessionId: string, frame: Frame): void {
  send?.(sessionCommand(sessionId, frame));
}

/** Sends one hub-level frame (subscribe, unsubscribe) as-is. */
export function sendHubFrame(frame: object): void {
  send?.(frame);
}
