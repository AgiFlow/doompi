import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoomComputerUseHostBinding } from '@agimon-ai/doompi-core/hubChannel';
import { doomApiCallerFrom } from '@agimon-ai/doompi-core/packageApi';

import { ComputerUseRecordingStore } from './computerUseRecordings';

const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const DESKTOP_HEADER = 'x-doompi-desktop';
type Transport = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'off'>;

/** The capability is discovered over the inherited Desktop IPC channel, never from environment flags. */
export async function createComputerUseBinding(
  transport: Transport = process,
  remotePolicy: {
    isDeviceAuthorized?: (deviceId: string) => boolean;
    stepUpRequired?: () => boolean;
  } = {},
): Promise<DoomComputerUseHostBinding | undefined> {
  if (!transport.send || !transport.connected) return undefined;
  const recordings = new ComputerUseRecordingStore(await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-recordings-')));
  let available = false;
  let enabled = false;
  let closed = false;
  let token = '';
  let generation: string | undefined;
  const ownedSessions = new Set<string>();
  const revokedSessions = new Set<string>();
  const listeners = new Map<() => void, string | undefined>();
  const delegations = new Map<
    string,
    { deviceId: string; approved: boolean; abort: AbortController; grantId?: string; expiresAt?: number }
  >();
  const nativeAuthorized = (headers: Headers): boolean => {
    const proof = headers.get(DESKTOP_HEADER) ?? '';
    return available && /^[a-f0-9]{64}$/u.test(proof) && timingSafeEqual(Buffer.from(proof), Buffer.from(token));
  };
  const remoteCaller = (headers: Headers) => {
    const caller = doomApiCallerFrom(headers);
    return caller?.locality === 'remote' && remotePolicy.isDeviceAuthorized?.(caller.deviceId) === true
      ? caller
      : undefined;
  };
  const notify = (sessionId?: string): void => {
    for (const [listener, session] of listeners) if (sessionId === undefined || session === sessionId) listener();
  };
  const revoke = (sessionId: string, retainRecording = false): void => {
    const delegated = delegations.get(sessionId);
    if (delegated === undefined) return;
    if (!retainRecording) delegations.delete(sessionId);
    delegated.expiresAt = undefined;
    delegated.abort.abort();
    revokedSessions.add(sessionId);
    if (delegated.grantId !== undefined && available) {
      void exchange(
        { type: 'doompi:computer-use:request', sessionId, operation: 'stop', payload: { grantId: delegated.grantId } },
        30_000,
      )
        .then((result) => recordings.importStop(sessionId, delegated.grantId!, result.result))
        .catch(() => close());
    }
    notify(sessionId);
  };
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
    for (const sessionId of delegations.keys()) revoke(sessionId);
    notify();
    listeners.clear();
    void recordings.close().catch(() => process.emitWarning('Computer-use recording cleanup failed.'));
    // Keep ownership pinned while the server is alive, including after Desktop disconnects.
  };
  const onMessage = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.version !== VERSION) return;
    if (message.type === 'doompi:computer-use:availability' && typeof message.enabled === 'boolean') {
      enabled = message.enabled;
      // Native stop/expiry also notifies availability without changing the global setting.
      for (const sessionId of delegations.keys()) revoke(sessionId, true);
      notify();
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
    authorize: nativeAuthorized,
    readRecording: (scope, artifactId, range) => recordings.read(scope.sessionId, artifactId, range),
    authorizeActivation(headers) {
      if (!available || !enabled) return false;
      if (nativeAuthorized(headers)) return true;
      const caller = remoteCaller(headers);
      return (
        caller !== undefined &&
        (remotePolicy.stepUpRequired?.() === true ? caller.stepUp === 'verified' : caller.stepUp === 'not-required')
      );
    },
    authorizePending(sessionId, headers) {
      if (nativeAuthorized(headers)) return true;
      const caller = remoteCaller(headers);
      const delegated = delegations.get(sessionId);
      return (
        available &&
        enabled &&
        caller !== undefined &&
        delegated !== undefined &&
        delegated.deviceId === caller.deviceId &&
        delegated.expiresAt === undefined &&
        !delegated.abort.signal.aborted
      );
    },
    authorizeRecording(sessionId, headers) {
      if (nativeAuthorized(headers)) return true;
      const caller = remoteCaller(headers);
      const delegated = delegations.get(sessionId);
      return (
        available && caller !== undefined && delegated?.approved === true && delegated.deviceId === caller.deviceId
      );
    },
    authorizeSession(sessionId, headers) {
      if (nativeAuthorized(headers)) return true;
      const caller = remoteCaller(headers);
      const delegated = delegations.get(sessionId);
      if (available && enabled && caller !== undefined && !ownedSessions.has(sessionId)) return true;
      return (
        available &&
        enabled &&
        caller !== undefined &&
        delegated?.approved === true &&
        delegated.expiresAt !== undefined &&
        delegated.expiresAt > Date.now() &&
        delegated.deviceId === caller.deviceId &&
        !delegated.abort.signal.aborted
      );
    },
    claimSession(sessionId, headers) {
      if (!available || !enabled) throw new Error('Desktop computer use is unavailable.');
      const caller = headers === undefined ? undefined : remoteCaller(headers);
      if (caller !== undefined) {
        const previous = delegations.get(sessionId);
        if (previous !== undefined && previous.deviceId !== caller.deviceId)
          throw new Error('This session belongs to another paired device.');
        if (previous?.abort.signal.aborted) {
          previous.abort = new AbortController();
          previous.grantId = undefined;
        }
        if (previous === undefined)
          delegations.set(sessionId, {
            deviceId: caller.deviceId,
            approved: false,
            abort: new AbortController(),
          });
      } else if (headers !== undefined && !nativeAuthorized(headers)) {
        throw new Error('Native or paired authorization is required.');
      }
      revokedSessions.delete(sessionId);
      ownedSessions.add(sessionId);
    },
    revokeDevice(deviceId) {
      for (const [sessionId, delegated] of delegations) if (delegated.deviceId === deviceId) revoke(sessionId);
    },
    ownsSession: (sessionId) => ownedSessions.has(sessionId),
    forgetSession: (sessionId) => {
      revoke(sessionId);
      void recordings
        .forgetSession(sessionId)
        .catch(() => process.emitWarning('Computer-use recording cleanup failed.'));
      // Keep private history pinned to Desktop, but never replay device approval after restart.
    },
    subscribe(listener, sessionId) {
      listeners.set(listener, sessionId);
      return () => {
        listeners.delete(listener);
      };
    },
    async request(scope, request) {
      if (!available) throw new Error('Desktop computer use is unavailable.');
      if (revokedSessions.has(scope.sessionId) && request.operation !== 'stop' && request.operation !== 'status')
        throw new Error('Computer-use delegation was revoked.');
      if (request.operation !== 'status' && request.operation !== 'targets' && !ownedSessions.has(scope.sessionId)) {
        throw new Error('This session has not been authorized by Desktop.');
      }
      const delegated = delegations.get(scope.sessionId);
      if (delegated !== undefined && remotePolicy.isDeviceAuthorized?.(delegated.deviceId) !== true) {
        revoke(scope.sessionId);
        if (request.operation !== 'stop') throw new Error('The paired device was revoked.');
      }
      if (request.operation === 'stop' && delegated !== undefined) {
        delegated.expiresAt = undefined;
        delegated.abort.abort();
      }
      const signal =
        delegated === undefined || request.operation === 'stop'
          ? request.signal
          : request.signal === undefined
            ? delegated.abort.signal
            : AbortSignal.any([request.signal, delegated.abort.signal]);
      const result = await exchange(
        {
          type: 'doompi:computer-use:request',
          sessionId: scope.sessionId,
          operation: request.operation,
          ...(request.payload === undefined ? {} : { payload: request.payload }),
        },
        request.operation === 'activate' ? 120_000 : 30_000,
        signal,
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
      if (request.operation === 'activate' && delegated !== undefined) {
        if (
          delegations.get(scope.sessionId) !== delegated ||
          delegated.abort.signal.aborted ||
          remotePolicy.isDeviceAuthorized?.(delegated.deviceId) !== true
        )
          throw new Error('The paired activation was revoked.');
        delegated.approved = true;
        const grant = result.result as { grantId?: unknown; expiresAt?: unknown } | undefined;
        if (typeof grant?.expiresAt === 'number') delegated.expiresAt = grant.expiresAt;
        if (typeof grant?.grantId === 'string') delegated.grantId = grant.grantId;
      }
      if (request.operation === 'stop') {
        if (delegated !== undefined) delegated.expiresAt = undefined;
        const grantId = (request.payload as { grantId?: unknown } | undefined)?.grantId;
        if (typeof grantId !== 'string') throw new Error('Recording finalization requires its grant.');
        return recordings.importStop(scope.sessionId, grantId, result.result);
      }
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
