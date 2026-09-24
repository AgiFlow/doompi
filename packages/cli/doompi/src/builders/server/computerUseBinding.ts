import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { DoomComputerUseHostBinding } from '@agimon-ai/doompi-core/hubChannel';

const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const DESKTOP_HEADER = 'x-doompi-desktop';
type Transport = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'off'>;

/** The capability is discovered over the inherited Desktop IPC channel, never from environment flags. */
export async function createComputerUseBinding(
  transport: Transport = process,
): Promise<DoomComputerUseHostBinding | undefined> {
  if (!transport.send || !transport.connected) return undefined;
  let available = false;
  let enabled = false;
  let closed = false;
  let token = '';
  let generation: string | undefined;
  const ownedSessions = new Set<string>();
  const listeners = new Set<() => void>();
  const pending = new Map<string, { finish: (value?: Record<string, unknown>, error?: Error) => void }>();
  const send = (value: object): void => {
    if (closed || !transport.connected) throw new Error('Desktop computer use is disconnected.');
    transport.send!(value, (error: Error | null) => {
      if (error) close();
    });
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    available = false;
    token = '';
    transport.off('message', onMessage);
    transport.off('disconnect', close);
    transport.off('exit', close);
    for (const request of pending.values())
      request.finish(undefined, new Error('Desktop computer use is disconnected.'));
    pending.clear();
    for (const listener of listeners) listener();
    listeners.clear();
    // Keep ownership pinned while the server is alive, including after Desktop disconnects.
  };
  const onMessage = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.version !== VERSION) return;
    if (message.type === 'doompi:computer-use:availability' && typeof message.enabled === 'boolean') {
      enabled = message.enabled;
      for (const listener of listeners) listener();
      return;
    }
    if (typeof message.requestId !== 'string') return;
    if (message.type !== 'doompi:computer-use:ready' && message.type !== 'doompi:computer-use:response') return;
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_BYTES) {
      close();
      return;
    }
    pending.get(message.requestId)?.finish(message);
  };
  transport.on('message', onMessage);
  transport.on('disconnect', close);
  transport.on('exit', close);

  const exchange = (
    value: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (closed || pending.size >= 128) throw new Error('Desktop computer-use transport is unavailable or busy.');
      const requestId = randomUUID();
      const cancel = (): void => {
        try {
          send({ type: 'doompi:computer-use:cancel', version: VERSION, requestId });
        } catch {
          /* Already disconnected. */
        }
      };
      const finish = (result?: Record<string, unknown>, error?: Error): void => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const onAbort = (): void => {
        cancel();
        finish(undefined, new Error('Desktop computer-use request was cancelled.'));
      };
      const timer = setTimeout(() => {
        cancel();
        finish(undefined, new Error('Desktop computer-use request timed out.'));
      }, timeoutMs);
      pending.set(requestId, { finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const message = { ...value, version: VERSION, requestId };
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_BYTES)
          throw new Error('Desktop computer-use request is too large.');
        send(message);
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    });

  try {
    const ready = await exchange({ type: 'doompi:computer-use:hello' }, 1_500);
    if (
      ready.type !== 'doompi:computer-use:ready' ||
      typeof ready.token !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(ready.token)
    ) {
      throw new Error('Invalid Desktop capability handshake.');
    }
    token = ready.token;
    available = true;
    enabled = ready.enabled === true;
  } catch {
    close();
    return undefined;
  }

  return {
    get available() {
      return available;
    },
    get enabled() {
      return available && enabled;
    },
    authorize(headers) {
      const proof = headers.get(DESKTOP_HEADER) ?? '';
      return available && /^[a-f0-9]{64}$/u.test(proof) && timingSafeEqual(Buffer.from(proof), Buffer.from(token));
    },
    claimSession(sessionId) {
      if (!available) throw new Error('Desktop computer use is unavailable.');
      ownedSessions.add(sessionId);
    },
    ownsSession: (sessionId) => ownedSessions.has(sessionId),
    forgetSession: (sessionId) => {
      ownedSessions.delete(sessionId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async request(scope, request) {
      if (!available) throw new Error('Desktop computer use is unavailable.');
      if (request.operation !== 'status' && request.operation !== 'targets' && !ownedSessions.has(scope.sessionId)) {
        throw new Error('This session has not been authorized by Desktop.');
      }
      const result = await exchange(
        {
          type: 'doompi:computer-use:request',
          sessionId: scope.sessionId,
          operation: request.operation,
          ...(request.payload === undefined ? {} : { payload: request.payload }),
        },
        request.operation === 'activate' ? 120_000 : 30_000,
        request.signal,
      );
      if (
        typeof result.hostGeneration !== 'string' ||
        (generation !== undefined && generation !== result.hostGeneration)
      ) {
        close();
        throw new Error('Desktop generation changed. Authorize a new session.');
      }
      generation = result.hostGeneration;
      if (result.ok !== true)
        throw new Error(typeof result.error === 'string' ? result.error : 'Desktop request failed.');
      return result.result;
    },
    close() {
      if (closed) return;
      try {
        send({ type: 'doompi:computer-use:close', version: VERSION });
      } finally {
        close();
      }
    },
  };
}
