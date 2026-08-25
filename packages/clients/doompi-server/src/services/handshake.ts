import type { SessionFrame } from '../types/session.ts';

export const HANDSHAKE_TYPE = 'attach';
export const HANDSHAKE_OK_TYPE = 'attached';
export const HANDSHAKE_ERROR_TYPE = 'attach_error';
export const REPLAY_TYPE = 'replay';

export type HandshakeOutcome = { accepted: true } | { accepted: false; reason: string };

/**
 * Decides whether a connecting client may take over the session.
 *
 * The first frame has to be the attach frame carrying the token. Comparing
 * lengths before contents is deliberate: a client that guesses the length
 * learns nothing else from the timing of the rejection.
 */
export function evaluateHandshake(
  frame: SessionFrame,
  token: string,
  compare: (candidate: string, expected: string) => boolean,
): HandshakeOutcome {
  if (frame.type !== HANDSHAKE_TYPE) {
    return { accepted: false, reason: `The first frame must be "${HANDSHAKE_TYPE}".` };
  }
  const presented = frame.token;
  if (typeof presented !== 'string' || !compare(presented, token)) {
    return { accepted: false, reason: 'The attach token was rejected.' };
  }
  return { accepted: true };
}

export function handshakeAccepted(replayed: number, dropped: number): SessionFrame {
  return { type: HANDSHAKE_OK_TYPE, replayed, dropped };
}

export function handshakeRejected(reason: string): SessionFrame {
  return { type: HANDSHAKE_ERROR_TYPE, reason };
}

/** Marks frames the client missed while it was away. */
export function replayFrame(frame: SessionFrame): SessionFrame {
  return { type: REPLAY_TYPE, frame };
}
