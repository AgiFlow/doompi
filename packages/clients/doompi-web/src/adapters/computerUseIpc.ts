import { randomUUID } from 'node:crypto';
import type { ComputerUseHostBinding, ComputerUseHostRequest, HubSessionScope } from '@agimon-ai/doompi-web-contracts';

const REQUEST_TYPE = 'doompi:computer-use:request';
const RESPONSE_TYPE = 'doompi:computer-use:response';
const CANCEL_TYPE = 'doompi:computer-use:cancel';
const VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;

export type IpcProcess = Pick<NodeJS.Process, 'connected' | 'send' | 'on' | 'off'>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

function messageBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isResponse(value: unknown): value is {
  type: typeof RESPONSE_TYPE;
  version: typeof VERSION;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
} {
  if (messageBytes(value) > MAX_MESSAGE_BYTES) return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === RESPONSE_TYPE &&
    candidate.version === VERSION &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.ok === 'boolean'
  );
}

export function createComputerUseIpcBinding(
  child: IpcProcess = process,
  onNotice: (message: string) => void = () => undefined,
): ComputerUseHostBinding | undefined {
  if (child.connected !== true || typeof child.send !== 'function') return undefined;

  const pending = new Map<string, PendingRequest>();
  let closed = false;

  const cancelRequest = (requestId: string): void => {
    if (closed || child.connected !== true || typeof child.send !== 'function') return;
    child.send({ type: CANCEL_TYPE, version: VERSION, requestId });
  };
  const settle = (requestId: string, result: { ok: true; value: unknown } | { ok: false; error: Error }): void => {
    const held = pending.get(requestId);
    if (held === undefined) return;
    pending.delete(requestId);
    clearTimeout(held.timer);
    if (held.signal !== undefined && held.abort !== undefined) held.signal.removeEventListener('abort', held.abort);
    if (result.ok) held.resolve(result.value);
    else held.reject(result.error);
  };

  const onMessage = (value: unknown): void => {
    if (!isResponse(value)) return;
    if (value.ok) settle(value.requestId, { ok: true, value: value.result });
    else settle(value.requestId, { ok: false, error: new Error(value.error ?? 'Desktop computer use failed.') });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (child.connected === true && typeof child.send === 'function') {
      child.send({ type: 'doompi:computer-use:close', version: VERSION });
    }
    child.off('message', onMessage);
    child.off('disconnect', onDisconnect);
    for (const requestId of pending.keys()) {
      settle(requestId, { ok: false, error: new Error('DoomPi Desktop disconnected.') });
    }
  };

  const onDisconnect = (): void => {
    onNotice('DoomPi Desktop computer-use capability disconnected');
    close();
  };

  child.on('message', onMessage);
  child.on('disconnect', onDisconnect);

  const request = async (scope: HubSessionScope, input: ComputerUseHostRequest): Promise<unknown> => {
    if (closed || child.connected !== true || typeof child.send !== 'function') {
      throw new Error('DoomPi Desktop computer-use capability is unavailable.');
    }
    if (pending.size >= MAX_PENDING_REQUESTS) throw new Error('Too many pending computer-use requests.');
    const requestId = randomUUID();
    const message = {
      type: REQUEST_TYPE,
      version: VERSION,
      requestId,
      sessionId: scope.sessionId,
      operation: input.operation,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    };
    if (messageBytes(message) > MAX_MESSAGE_BYTES) throw new Error('The computer-use request is too large.');

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelRequest(requestId);
        settle(requestId, { ok: false, error: new Error('The Desktop computer-use request timed out.') });
      }, REQUEST_TIMEOUT_MS);
      const abort =
        input.signal === undefined
          ? undefined
          : (): void => {
              cancelRequest(requestId);
              settle(requestId, { ok: false, error: new Error('The computer-use request was cancelled.') });
            };
      pending.set(requestId, { resolve, reject, timer, signal: input.signal, abort });
      if (abort !== undefined) input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted === true) {
        abort?.();
        return;
      }
      child.send?.(message, (error) => {
        if (error !== null) settle(requestId, { ok: false, error });
      });
    });
  };

  return { available: true, request, close };
}
