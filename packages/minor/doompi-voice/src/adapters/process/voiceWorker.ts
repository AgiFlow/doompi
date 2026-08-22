import type { MessagePort } from 'node:worker_threads';
import { isMainThread, parentPort } from 'node:worker_threads';

import {
  parseVoiceWorkerCommand,
  type VoiceWorkerCommand,
  type VoiceWorkerEvent,
  type VoiceWorkerEventPayload,
  VOICE_WORKER_PROTOCOL_VERSION,
} from '../../services/voiceWorkerProtocol.ts';
import { VoiceWorkerPipeline } from './voiceWorkerPipeline.ts';

const HEARTBEAT_INTERVAL_MS = 1_000;

export type VoiceWorkerPublish = (event: VoiceWorkerEventPayload) => void;

export interface VoiceWorkerRuntimeHooks {
  initialize?(
    command: Extract<VoiceWorkerCommand, { kind: 'initialize' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> | void;
  capabilities?(): readonly string[];
  handle(
    command: Exclude<VoiceWorkerCommand, { kind: 'initialize' | 'shutdown' }>,
    publish: VoiceWorkerPublish,
  ): Promise<void> | void;
  shutdown(reason: 'session-shutdown' | 'extension-dispose'): Promise<void> | void;
}

export interface VoiceWorkerRuntimeHandle {
  dispose(): Promise<void>;
}

interface MessagePortLike {
  on(event: 'message', listener: (value: unknown) => void): this;
  off(event: 'message', listener: (value: unknown) => void): this;
  postMessage(value: VoiceWorkerEvent): void;
  close(): void;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.replace(/[^a-z0-9]+/giu, '_').toLowerCase();
  return 'voice_worker_command_failed';
}

function invalidControlMessageCode(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid_control_message';
  if (error.message.startsWith('Unsupported voice worker protocol version:'))
    return 'invalid_control_message_protocol_version';
  const field = /^(?:Unexpected voice worker message field:|Voice worker field) ([a-zA-Z0-9_-]+)/u.exec(
    error.message,
  )?.[1];
  if (field) return `invalid_control_message_${field.replace(/[^a-z0-9]+/giu, '_').toLowerCase()}`;
  if (error.message.startsWith('Unsupported voice worker command:')) return 'invalid_control_message_command';
  if (error.message.includes('binary audio data')) return 'invalid_control_message_binary_audio';
  return 'invalid_control_message';
}

export function startVoiceWorker(
  port: MessagePortLike = parentPort as MessagePort,
  hooks: VoiceWorkerRuntimeHooks = new VoiceWorkerPipeline(),
): VoiceWorkerRuntimeHandle {
  if (!port) throw new Error('Voice worker requires a parent MessagePort.');

  const startedAt = Date.now();
  let eventSequence = 0;
  let initialized = false;
  let initializing = false;
  let disposed = false;
  let lastCommandSequence = -1;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const publish = (event: VoiceWorkerEventPayload): void => {
    if (disposed) return;
    port.postMessage({
      ...event,
      version: VOICE_WORKER_PROTOCOL_VERSION,
      sequence: eventSequence,
    } as VoiceWorkerEvent);
    eventSequence += 1;
  };

  const stopHeartbeat = (): void => {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const dispose = async (reason: 'session-shutdown' | 'extension-dispose' = 'extension-dispose'): Promise<void> => {
    if (disposed) return;
    disposed = true;
    stopHeartbeat();
    port.off('message', onMessage);
    await hooks.shutdown(reason);
    port.close();
  };

  const onMessage = (value: unknown): void => {
    let command: VoiceWorkerCommand;
    try {
      command = parseVoiceWorkerCommand(value);
    } catch (error) {
      publish({ kind: 'failure', code: invalidControlMessageCode(error), recoverable: true });
      return;
    }

    if (command.sequence <= lastCommandSequence) {
      publish({ kind: 'failure', code: 'non_monotonic_sequence', recoverable: true });
      return;
    }
    lastCommandSequence = command.sequence;

    if (command.kind === 'initialize') {
      if (initialized || initializing) {
        publish({ kind: 'failure', code: 'already_initialized', recoverable: true });
        return;
      }
      initializing = true;
      void Promise.resolve(hooks.initialize?.(command, publish)).then(
        () => {
          initializing = false;
          initialized = true;
          publish({
            kind: 'ready',
            capabilities: [...(hooks.capabilities?.() ?? ['capture', 'transcription', 'durable-spool'])],
          });
          heartbeat = setInterval(() => {
            publish({ kind: 'heartbeat', workerUptimeMs: Math.max(0, Date.now() - startedAt) });
          }, HEARTBEAT_INTERVAL_MS);
          heartbeat.unref();
        },
        () => {
          initializing = false;
          publish({ kind: 'failure', code: 'initialization_failed', recoverable: false });
        },
      );
      return;
    }

    if (!initialized) {
      publish({ kind: 'failure', code: 'not_initialized', recoverable: true });
      return;
    }

    if (command.kind === 'shutdown') {
      void dispose(command.reason);
      return;
    }

    void Promise.resolve(hooks.handle(command, publish)).catch((error: unknown) => {
      publish({
        kind: 'failure',
        code: errorCode(error),
        recoverable: true,
        ...('sessionId' in command ? { sessionId: command.sessionId } : {}),
        ...('captureId' in command ? { captureId: command.captureId } : {}),
        ...('turnId' in command ? { turnId: command.turnId } : {}),
        ...('revision' in command ? { revision: command.revision } : {}),
      });
    });
  };

  port.on('message', onMessage);
  return { dispose };
}

if (!isMainThread) startVoiceWorker();
