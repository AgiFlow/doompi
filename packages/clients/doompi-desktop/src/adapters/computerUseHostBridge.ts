import type { ChildProcess } from 'node:child_process';
import { ComputerUseHost } from '../services/computerUseHost.ts';
import {
  COMPUTER_USE_IPC_CANCEL,
  COMPUTER_USE_IPC_REQUEST,
  COMPUTER_USE_IPC_VERSION,
  COMPUTER_USE_MAX_IPC_BYTES,
  type ComputerUseDesktopOperation,
  type ComputerUseDesktopRequest,
} from '../types/computerUse.ts';

const OPERATIONS = new Set<ComputerUseDesktopOperation>(['status', 'targets', 'activate', 'observe', 'act', 'stop']);
const MAX_ACTIVE_REQUESTS = 128;

function messageBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function parseRequest(value: unknown): ComputerUseDesktopRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (messageBytes(value) > COMPUTER_USE_MAX_IPC_BYTES) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== COMPUTER_USE_IPC_REQUEST ||
    candidate.version !== COMPUTER_USE_IPC_VERSION ||
    typeof candidate.requestId !== 'string' ||
    candidate.requestId === '' ||
    candidate.requestId.length > 128 ||
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId === '' ||
    candidate.sessionId.length > 256 ||
    typeof candidate.operation !== 'string' ||
    !OPERATIONS.has(candidate.operation as ComputerUseDesktopOperation)
  ) {
    return undefined;
  }
  return candidate as unknown as ComputerUseDesktopRequest;
}

function cancelledRequestId(value: unknown): string | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    messageBytes(value) > COMPUTER_USE_MAX_IPC_BYTES
  )
    return undefined;
  const candidate = value as Record<string, unknown>;
  return candidate.type === COMPUTER_USE_IPC_CANCEL &&
    candidate.version === COMPUTER_USE_IPC_VERSION &&
    typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 128
    ? candidate.requestId
    : undefined;
}

export interface ComputerUseHostBridge {
  close(): Promise<void>;
}

export function attachComputerUseHostBridge(
  child: ChildProcess,
  host: ComputerUseHost,
  onNotice: (message: string) => void = () => undefined,
): ComputerUseHostBridge {
  let closed = false;
  const activeRequests = new Map<string, AbortController>();
  const revokeHost = (reason: string): void => {
    for (const controller of activeRequests.values()) controller.abort();
    activeRequests.clear();
    void host.revoke(reason);
  };
  const revoke = (): void => revokeHost('hub_disconnected');
  const onMessage = (value: unknown): void => {
    if (closed) return;
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      messageBytes(value) <= COMPUTER_USE_MAX_IPC_BYTES &&
      (value as Record<string, unknown>).type === 'doompi:computer-use:close' &&
      (value as Record<string, unknown>).version === COMPUTER_USE_IPC_VERSION
    ) {
      revokeHost('hub_closed');
      return;
    }
    const cancelled = cancelledRequestId(value);
    if (cancelled !== undefined) {
      activeRequests.get(cancelled)?.abort();
      return;
    }
    const request = parseRequest(value);
    if (request === undefined || activeRequests.has(request.requestId) || activeRequests.size >= MAX_ACTIVE_REQUESTS) {
      onNotice('rejected an invalid computer-use IPC message');
      return;
    }
    const controller = new AbortController();
    activeRequests.set(request.requestId, controller);
    void host
      .handle(request, controller.signal)
      .then(
        (response) => child.send?.(response),
        (error: unknown) =>
          onNotice(`computer-use host request failed (${error instanceof Error ? error.message : String(error)})`),
      )
      .finally(() => activeRequests.delete(request.requestId));
  };

  child.on('message', onMessage);
  child.on('disconnect', revoke);
  child.on('exit', revoke);

  return {
    async close() {
      if (closed) return;
      closed = true;
      child.off('message', onMessage);
      child.off('disconnect', revoke);
      child.off('exit', revoke);
      for (const controller of activeRequests.values()) controller.abort();
      activeRequests.clear();
      await host.revoke('desktop_stopping');
    },
  };
}
