import { replicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { HubService, ProtocolEvent } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { WSContext, type WSEvents } from 'hono/ws';

const MAX_EVENTS = 1024;
const MAX_BYTES = 16 * 1024 * 1024;

/** Reuse guarded hub handlers without opening a second browser transport. */
export function createHubProtocol(events: WSEvents, disconnect: () => void): { service: HubService; close(): void } {
  let sequence = 0;
  let bytes = 0;
  let closed = false;
  const sizes: number[] = [];
  const state = replicatedState<{ events: ProtocolEvent[] }>({ events: [] });
  const close = (): void => {
    if (closed) return;
    closed = true;
    events.onClose?.(new Event('close') as CloseEvent, socket);
  };
  const terminate = (): void => {
    try {
      close();
    } finally {
      disconnect();
    }
  };
  const socket = new WSContext({
    readyState: 1,
    send(data) {
      if (closed) return;
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      const frame: ProtocolEvent['frame'] = JSON.parse(text);
      if (typeof frame.type !== 'string') throw new Error('Hub event has no type.');
      const size = Buffer.byteLength(text);
      if (size > MAX_BYTES) {
        terminate();
        throw new Error('Hub event exceeds protocol limit.');
      }
      sizes.push(size);
      bytes += size;
      const next = [...state.state.events, { sequence: ++sequence, frame }];
      while (next.length > MAX_EVENTS || bytes > MAX_BYTES) {
        next.shift();
        bytes -= sizes.shift() ?? 0;
      }
      state.state.events = next;
      state.publish(BACKGROUND_CONTEXT);
    },
    close: terminate,
  });
  try {
    events.onOpen?.(new Event('open'), socket);
  } catch (error) {
    terminate();
    throw error;
  }
  return {
    service: {
      state,
      async send(frame, context) {
        context.abortSignal?.throwIfAborted();
        if (closed) throw new Error('Hub connection is closed.');
        if (!frame || typeof frame.type !== 'string') throw new Error('Invalid hub command.');
        const text = JSON.stringify(frame);
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Hub command exceeds protocol limit.');
        events.onMessage?.(new MessageEvent('message', { data: text }), socket);
      },
    },
    close,
  };
}
