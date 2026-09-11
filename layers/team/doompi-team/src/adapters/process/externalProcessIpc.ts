import { randomUUID } from 'node:crypto';

import type { SessionScope } from '../filesystem/paths';

export const EXTERNAL_IPC_CHANNEL = 'doompi-team-external';
export const EXTERNAL_IPC_VERSION = 1 as const;
export const MAX_EXTERNAL_IPC_MESSAGE_BYTES = 256 * 1024;
const MAX_RUN_ID_LENGTH = 256;
const MAX_SCOPE_KEY_LENGTH = 512;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_REQUEST_ID_LENGTH = 256;

export interface ExternalRunProjection {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  runtime: string;
  state: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  summary?: string;
  activityState?: string;
  attentionReason?: string;
  sessionFile?: string;
  transcriptPath?: string;
  tokens?: number;
  cost?: number;
  currentTool?: string;
  toolCount?: number;
}

export interface ExternalRunnerReadyMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'runner';
  kind: 'ready';
  runId: string;
  scopeKey: string;
}

export interface ExternalRunnerStatusMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'runner';
  kind: 'status';
  runId: string;
  scopeKey: string;
  status: ExternalRunProjection;
}

export interface ExternalRunnerResultMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'runner';
  kind: 'result';
  runId: string;
  scopeKey: string;
  result: Record<string, unknown>;
}

export interface ExternalRunnerErrorMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'runner';
  kind: 'error';
  runId: string;
  scopeKey: string;
  error: string;
}

export interface ExternalRunnerAckMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'runner';
  kind: 'ack';
  runId: string;
  scopeKey: string;
  requestId: string;
  command: 'steer';
  state: 'delivered' | 'failed';
  message: string;
}

export type ExternalRunnerMessage =
  | ExternalRunnerReadyMessage
  | ExternalRunnerStatusMessage
  | ExternalRunnerResultMessage
  | ExternalRunnerErrorMessage
  | ExternalRunnerAckMessage;

export interface ExternalLaunchMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'parent';
  kind: 'launch';
  runId: string;
  scopeKey: string;
  config: Record<string, unknown>;
}

export interface ExternalControlMessage {
  channel: typeof EXTERNAL_IPC_CHANNEL;
  version: typeof EXTERNAL_IPC_VERSION;
  direction: 'parent';
  kind: 'control';
  runId: string;
  scopeKey: string;
  requestId: string;
  command: 'interrupt' | 'timeout' | 'stop' | 'steer';
  reason?: string;
  message?: string;
  targetIndex?: number;
}

export type ExternalParentMessage = ExternalLaunchMessage | ExternalControlMessage;

export interface ExternalProcessEndpoint {
  onMessage(handler: (message: unknown) => void): () => void;
  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  send(message: object): Promise<void>;
  disconnect?(): void;
}

function text(value: unknown, max = MAX_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= max;
}

function identity(value: unknown, max: number): value is string {
  return text(value, max) && value.length > 0 && !value.includes('\u0000');
}

export function externalIpcMessageWithinLimit(message: object): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_EXTERNAL_IPC_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

export function parseExternalRunnerMessage(
  value: unknown,
  expected?: { runId?: string; scopeKey?: string },
): ExternalRunnerMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.channel !== EXTERNAL_IPC_CHANNEL ||
    input.version !== EXTERNAL_IPC_VERSION ||
    input.direction !== 'runner' ||
    !identity(input.runId, MAX_RUN_ID_LENGTH) ||
    !identity(input.scopeKey, MAX_SCOPE_KEY_LENGTH) ||
    (expected?.runId !== undefined && input.runId !== expected.runId) ||
    (expected?.scopeKey !== undefined && input.scopeKey !== expected.scopeKey) ||
    !externalIpcMessageWithinLimit(value as object)
  )
    return undefined;

  const base = {
    channel: EXTERNAL_IPC_CHANNEL as typeof EXTERNAL_IPC_CHANNEL,
    version: EXTERNAL_IPC_VERSION as typeof EXTERNAL_IPC_VERSION,
    direction: 'runner' as const,
    runId: input.runId,
    scopeKey: input.scopeKey,
  };
  switch (input.kind) {
    case 'ready':
      return { ...base, kind: 'ready' };
    case 'error':
      return text(input.error) ? { ...base, kind: 'error', error: input.error } : undefined;
    case 'ack':
      return identity(input.requestId, MAX_REQUEST_ID_LENGTH) &&
        input.command === 'steer' &&
        (input.state === 'delivered' || input.state === 'failed') &&
        text(input.message, 1_000)
        ? {
            ...base,
            kind: 'ack',
            requestId: input.requestId,
            command: 'steer',
            state: input.state,
            message: input.message,
          }
        : undefined;
    case 'result': {
      if (!input.result || typeof input.result !== 'object' || Array.isArray(input.result)) return undefined;
      return { ...base, kind: 'result', result: input.result as Record<string, unknown> };
    }
    case 'status': {
      if (!input.status || typeof input.status !== 'object' || Array.isArray(input.status)) return undefined;
      const status = input.status as Record<string, unknown>;
      if (
        status.runId !== input.runId ||
        !identity(status.agent, MAX_TEXT_LENGTH) ||
        !text(status.task) ||
        !text(status.cwd) ||
        !identity(status.runtime, 256) ||
        !identity(status.state, 64) ||
        typeof status.startedAt !== 'number' ||
        !Number.isFinite(status.startedAt) ||
        typeof status.updatedAt !== 'number' ||
        !Number.isFinite(status.updatedAt)
      )
        return undefined;
      return { ...base, kind: 'status', status: status as unknown as ExternalRunProjection };
    }
    default:
      return undefined;
  }
}

export function parseExternalParentMessage(
  value: unknown,
  expected?: { runId?: string; scopeKey?: string },
): ExternalParentMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (
    input.channel !== EXTERNAL_IPC_CHANNEL ||
    input.version !== EXTERNAL_IPC_VERSION ||
    input.direction !== 'parent' ||
    !identity(input.runId, MAX_RUN_ID_LENGTH) ||
    !identity(input.scopeKey, MAX_SCOPE_KEY_LENGTH) ||
    (expected?.runId !== undefined && input.runId !== expected.runId) ||
    (expected?.scopeKey !== undefined && input.scopeKey !== expected.scopeKey) ||
    !externalIpcMessageWithinLimit(value as object)
  )
    return undefined;
  const base = {
    channel: EXTERNAL_IPC_CHANNEL as typeof EXTERNAL_IPC_CHANNEL,
    version: EXTERNAL_IPC_VERSION as typeof EXTERNAL_IPC_VERSION,
    direction: 'parent' as const,
    runId: input.runId,
    scopeKey: input.scopeKey,
  };
  if (input.kind === 'launch') {
    return input.config && typeof input.config === 'object' && !Array.isArray(input.config)
      ? { ...base, kind: 'launch', config: input.config as Record<string, unknown> }
      : undefined;
  }
  if (input.kind !== 'control') return undefined;
  const requestId = input.requestId;
  const reason = input.reason;
  const message = input.message;
  const targetIndex = input.targetIndex;
  if (!identity(requestId, MAX_REQUEST_ID_LENGTH)) return undefined;
  if (
    input.command !== 'interrupt' &&
    input.command !== 'timeout' &&
    input.command !== 'stop' &&
    input.command !== 'steer'
  )
    return undefined;
  if (reason !== undefined && !text(reason, 4_096)) return undefined;
  if (message !== undefined && !text(message)) return undefined;
  if (
    targetIndex !== undefined &&
    (typeof targetIndex !== 'number' || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > 1_000_000)
  )
    return undefined;
  if (input.command === 'steer' && (typeof message !== 'string' || !message.trim() || message.length > 128 * 1024))
    return undefined;
  return {
    ...base,
    kind: 'control',
    requestId,
    command: input.command,
    ...(reason === undefined ? {} : { reason }),
    ...(message === undefined ? {} : { message }),
    ...(targetIndex === undefined ? {} : { targetIndex }),
  };
}

export function makeExternalLaunchMessage(scope: SessionScope, runId: string, config: object): ExternalLaunchMessage {
  const message: ExternalLaunchMessage = {
    channel: EXTERNAL_IPC_CHANNEL,
    version: EXTERNAL_IPC_VERSION,
    direction: 'parent',
    kind: 'launch',
    runId,
    scopeKey: scope.scopeKey,
    config: config as Record<string, unknown>,
  };
  if (!externalIpcMessageWithinLimit(message)) throw new Error('External launch message exceeds the IPC size limit.');
  return message;
}

export interface ExternalControlInput {
  command: ExternalControlMessage['command'];
  reason?: string;
  message?: string;
  targetIndex?: number;
  requestId?: string;
}

export function makeExternalControlMessage(
  scope: SessionScope,
  runId: string,
  input: ExternalControlInput,
): ExternalControlMessage {
  const message: ExternalControlMessage = {
    channel: EXTERNAL_IPC_CHANNEL,
    version: EXTERNAL_IPC_VERSION,
    direction: 'parent',
    kind: 'control',
    runId,
    scopeKey: scope.scopeKey,
    requestId: input.requestId ?? randomUUID(),
    command: input.command,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.targetIndex === undefined ? {} : { targetIndex: input.targetIndex }),
  };
  if (!externalIpcMessageWithinLimit(message)) throw new Error('External control message exceeds the IPC size limit.');
  if (!parseExternalParentMessage(message, { runId, scopeKey: scope.scopeKey }))
    throw new Error('External control message is invalid.');
  return message;
}

export function sendExternalProcessMessage(
  send: (message: object, callback: (error?: Error | null) => void) => unknown,
  message: object,
): Promise<void> {
  if (!externalIpcMessageWithinLimit(message))
    return Promise.reject(new Error('External IPC message exceeds the size limit.'));
  return new Promise((resolve, reject) => {
    try {
      send(message, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

interface ExternalEntry {
  scope: SessionScope;
  runId: string;
  endpoint: ExternalProcessEndpoint;
  removeMessage: () => void;
  removeExit: () => void;
}

export interface ExternalProcessExitEvent {
  scope: SessionScope;
  runId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type ExternalProcessEvent = { scope: SessionScope; message: ExternalRunnerMessage } | ExternalProcessExitEvent;
export type ExternalProcessEventListener = (event: ExternalProcessEvent) => void;

export class ExternalProcessIpc {
  private readonly entries = new Map<string, ExternalEntry>();
  private readonly listeners = new Set<ExternalProcessEventListener>();
  private readonly ackWaiters = new Map<
    string,
    { resolve: (message: ExternalRunnerAckMessage) => void; reject: (error: Error) => void }
  >();

  subscribe(listener: ExternalProcessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(scope: SessionScope, runId: string, endpoint: ExternalProcessEndpoint): () => void {
    const key = this.key(scope, runId);
    this.unregister(scope, runId);
    const removeMessage = endpoint.onMessage((raw) => {
      const message = parseExternalRunnerMessage(raw, { runId, scopeKey: scope.scopeKey });
      if (!message) return;
      if (message.kind === 'ack') this.ackWaiters.get(this.ackKey(key, message.requestId))?.resolve(message);
      for (const listener of this.listeners) listener({ scope, message });
    });
    const removeExit = endpoint.onExit((code, signal) => {
      for (const listener of this.listeners) listener({ scope, runId, code, signal });
      this.unregister(scope, runId);
    });
    this.entries.set(key, { scope, runId, endpoint, removeMessage, removeExit });
    return () => this.unregister(scope, runId);
  }

  has(scope: SessionScope, runId: string): boolean {
    return this.entries.has(this.key(scope, runId));
  }

  resolve(scope: SessionScope, id: string): string | undefined {
    const exact = this.entries.has(this.key(scope, id)) ? id : undefined;
    if (exact) return exact;
    const matches = [...this.entries.values()]
      .filter((entry) => entry.scope.scopeKey === scope.scopeKey && entry.runId.startsWith(id))
      .map((entry) => entry.runId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  async launch(scope: SessionScope, runId: string, config: object): Promise<void> {
    const entry = this.entries.get(this.key(scope, runId));
    if (!entry) throw new Error(`No external process is registered for run '${runId}'.`);
    await entry.endpoint.send(makeExternalLaunchMessage(scope, runId, config));
  }

  async control(
    scope: SessionScope,
    runId: string,
    input: ExternalControlInput,
    timeoutMs = 3_000,
  ): Promise<ExternalRunnerAckMessage | undefined> {
    const entry = this.entries.get(this.key(scope, runId));
    if (!entry) throw new Error(`No external process is registered for run '${runId}'.`);
    const message = makeExternalControlMessage(scope, runId, input);
    if (message.command !== 'steer') {
      await entry.endpoint.send(message);
      return undefined;
    }

    const key = this.ackKey(this.key(scope, runId), message.requestId);
    let timer: ReturnType<typeof setTimeout>;
    const acknowledgement = new Promise<ExternalRunnerAckMessage | undefined>((resolve, reject) => {
      timer = setTimeout(() => {
        this.ackWaiters.delete(key);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.ackWaiters.set(key, {
        resolve: (ack) => {
          clearTimeout(timer);
          this.ackWaiters.delete(key);
          resolve(ack);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.ackWaiters.delete(key);
          reject(error);
        },
      });
    });
    try {
      await entry.endpoint.send(message);
    } catch (error) {
      clearTimeout(timer!);
      this.ackWaiters.delete(key);
      throw error;
    }
    return acknowledgement;
  }
  unregister(scope: SessionScope, runId: string): void {
    const key = this.key(scope, runId);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.removeMessage();
    entry.removeExit();
    entry.endpoint.disconnect?.();
    for (const [waiterKey, waiter] of this.ackWaiters) {
      if (waiterKey.startsWith(`${key}\0`)) {
        waiter.reject(new Error(`External process for run '${runId}' exited before acknowledging the request.`));
        this.ackWaiters.delete(waiterKey);
      }
    }
  }

  close(): void {
    for (const entry of this.entries.values()) this.unregister(entry.scope, entry.runId);
    this.listeners.clear();
  }

  private key(scope: SessionScope, runId: string): string {
    return `${scope.scopeKey}\0${runId}`;
  }

  private ackKey(key: string, requestId: string): string {
    return `${key}\0${requestId}`;
  }
}

export function childProcessEndpoint(child: {
  on(event: 'message', handler: (message: unknown) => void): unknown;
  off?(event: 'message', handler: (message: unknown) => void): unknown;
  on(event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off?(event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  send?: (message: object, callback: (error?: Error) => void) => unknown;
  disconnect?: () => void;
}): ExternalProcessEndpoint {
  return {
    onMessage(handler) {
      child.on('message', handler);
      return () => child.off?.('message', handler);
    },
    onExit(handler) {
      child.on('exit', handler);
      return () => child.off?.('exit', handler);
    },
    send(message) {
      if (!child.send) return Promise.reject(new Error('External runner IPC is unavailable.'));
      return sendExternalProcessMessage(child.send.bind(child), message);
    },
    disconnect: () => child.disconnect?.(),
  };
}

export function sendRunnerMessage(message: ExternalRunnerMessage): Promise<void> {
  if (!process.send) return Promise.reject(new Error('External runner IPC is unavailable.'));
  return sendExternalProcessMessage(process.send.bind(process), message);
}
