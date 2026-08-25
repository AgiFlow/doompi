/** One newline-delimited JSON frame, kept opaque so Pi can evolve its protocol. */
export type SessionFrame = Record<string, unknown>;

/** Handshake vocabulary published by @agimon-ai/doompi-server. */
export const ATTACH_TYPE = 'attach';
export const ATTACHED_TYPE = 'attached';
export const ATTACH_ERROR_TYPE = 'attach_error';
export const REPLAY_TYPE = 'replay';

/**
 * What the browser is told about the socket behind it.
 *
 * The token never reaches the browser, so the page cannot infer attachment from
 * the handshake itself; the bridge reports it instead.
 */
export type BridgeState = 'connecting' | 'attached' | 'refused' | 'detached' | 'closed';

export const BRIDGE_STATUS_TYPE = 'bridge_status';

export interface BridgeStatusFrame {
  type: typeof BRIDGE_STATUS_TYPE;
  state: BridgeState;
  /** Human-readable cause, present when the state is refused or closed. */
  reason?: string;
  /** Frames the session buffered while nothing was attached. */
  replayed?: number;
  /** Frames the bounded backlog had to discard. */
  dropped?: number;
}

export function bridgeStatus(
  state: BridgeState,
  extra: Omit<BridgeStatusFrame, 'type' | 'state'> = {},
): BridgeStatusFrame {
  return { type: BRIDGE_STATUS_TYPE, state, ...extra };
}
