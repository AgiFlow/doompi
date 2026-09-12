import { sendSessionProtocolFrame } from './sessionProtocolCommands';

type Frame = Record<string, unknown>;

let send: ((frame: object) => void) | undefined;
let invokePlugin:
  | ((call: {
      mount:
        | { scope: 'global' }
        | { scope: 'workspace'; workspaceId: string }
        | { scope: 'session'; sessionId: string };
      service: string;
      method: string;
      input: unknown;
    }) => Promise<unknown>)
  | undefined;
const hubConnectedListeners = new Set<() => void>();

/**
 * Holds the live socket sender.
 *
 * The socket is owned by the composition root but commands are issued from
 * feature code, and this keeps that one indirection explicit instead of
 * threading a sender through every component.
 */
export function bindTransport(sender: (frame: object) => void, pluginInvoker?: typeof invokePlugin): void {
  send = sender;
  invokePlugin = pluginInvoker;
}

export function releaseTransport(): void {
  send = undefined;
  invokePlugin = undefined;
}

/** Sends one command frame to a session's agent, enveloped for the hub. */
export function sendFrame(sessionId: string, frame: Frame): void {
  sendSessionProtocolFrame(sessionId, frame);
}

/** Sends one hub-level frame (subscribe, unsubscribe) as-is. */
export function sendHubFrame(frame: object): void {
  send?.(frame);
}

/** Calls an exact-scope typed server method through the authenticated Chord binding. */
export function invokeServerMethod(call: Parameters<NonNullable<typeof invokePlugin>>[0]): Promise<unknown> {
  if (!invokePlugin) return Promise.reject(new Error('The plugin protocol is not connected.'));
  return invokePlugin(call);
}

/** Subscribes to fresh page socket connections. */
export function onHubConnected(listener: () => void): () => void {
  hubConnectedListeners.add(listener);
  return () => hubConnectedListeners.delete(listener);
}

/** Notifies page socket consumers after the hub establishes a fresh connection. */
export function notifyHubConnected(): void {
  for (const listener of hubConnectedListeners) listener();
}
