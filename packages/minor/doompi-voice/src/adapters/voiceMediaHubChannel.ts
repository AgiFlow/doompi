import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { VoiceOwnershipCoordinator } from '../services/voiceOwnershipCoordinator.ts';
import { VOICE_MEDIA_API_BASE_PATH, VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../types/clientMedia.ts';
import {
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  VOICE_OWNERSHIP_ROUTES,
  parseBrowserVoiceOwnershipPayload,
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipRegistration,
  parseVoiceOwnershipTransferRequest,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipCommand,
} from '../types/voiceOwnership.ts';
import { type VoiceMediaWakeSource, watchVoiceMediaWake } from './voiceMediaWakeFile.ts';

const OWNERSHIP_POLL_MS = 5_000;
const BROWSER_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;
const MAX_HANDLED_REQUEST_IDS_PER_SESSION = 64;
const MAX_HANDLED_REQUEST_SESSIONS = 256;
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createVoiceMediaWakeChannel(
  watch: typeof watchVoiceMediaWake = watchVoiceMediaWake,
  options: { browserAcknowledgementTimeoutMs?: number } = {},
): WebHubChannel {
  let receive: ((scope: HubSessionScope, payload: unknown, connectionId: string) => void) | undefined;
  let disconnected: ((connectionId: string) => void) | undefined;
  return {
    frameType: VOICE_MEDIA_WAKE_TYPE,
    receiveWithoutSubscription: true,
    start(host) {
      const latest = new Map<string, VoiceMediaWake>();
      const sources = new Map<string, VoiceMediaWakeSource>();
      const scopes = new Map<string, HubSessionScope>();
      const polling = new Set<string>();
      const handledRequests = new Map<string, Set<string>>();
      let mediaConnectionId: string | undefined;
      let browserRevision = 0;
      let closed = false;
      const pendingBrowser = new Map<
        string,
        {
          connectionId: string;
          timeout: ReturnType<typeof setTimeout>;
          resolve: (ack: Extract<BrowserVoiceOwnershipPayload, { type: 'browser-media-ack' }>) => void;
          reject: (error: Error) => void;
        }
      >();
      const browserCommand = async (
        scope: HubSessionScope,
        epoch: string,
        generation: number,
        action: 'detach' | 'attach' | 'ready',
        signal?: AbortSignal,
      ): Promise<void> => {
        signal?.throwIfAborted();
        if (closed) throw new Error('Voice media channel closed.');
        const connectionId = mediaConnectionId;
        if (connectionId === undefined || host.publishToConnection === undefined)
          throw new Error('Browser media runtime is unavailable.');
        const revision = ++browserRevision;
        const key = `${epoch}:${generation}:${revision}:${action}`;
        const command: BrowserVoiceOwnershipPayload = {
          type: 'browser-media-command',
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          epoch,
          generation,
          revision,
          action,
        };
        let abortPending: (() => void) | undefined;
        const acknowledgement = new Promise<Extract<BrowserVoiceOwnershipPayload, { type: 'browser-media-ack' }>>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              const pending = pendingBrowser.get(key);
              if (pending === undefined) return;
              pendingBrowser.delete(key);
              pending.reject(new Error(`Browser media ${action} acknowledgement timed out.`));
            }, options.browserAcknowledgementTimeoutMs ?? BROWSER_ACKNOWLEDGEMENT_TIMEOUT_MS);
            pendingBrowser.set(key, { connectionId, timeout, resolve, reject });
            abortPending = () => {
              const pending = pendingBrowser.get(key);
              if (pending === undefined) return;
              pendingBrowser.delete(key);
              clearTimeout(pending.timeout);
              pending.reject(
                signal?.reason instanceof Error ? signal.reason : new Error(`Browser media ${action} aborted.`),
              );
            };
            signal?.addEventListener('abort', abortPending, { once: true });
            if (signal?.aborted) abortPending();
          },
        );
        try {
          if (!signal?.aborted && !host.publishToConnection(connectionId, scope.sessionId, command)) {
            const pending = pendingBrowser.get(key);
            pendingBrowser.delete(key);
            if (pending !== undefined) clearTimeout(pending.timeout);
            throw new Error('Browser media runtime disconnected.');
          }
          const ack = await acknowledgement;
          if (!ack.ok || (action === 'ready' && ack.listening !== true))
            throw new Error(ack.error ?? `Browser media ${action} failed.`);
        } finally {
          if (abortPending !== undefined) signal?.removeEventListener('abort', abortPending);
        }
      };
      const coordinator = new VoiceOwnershipCoordinator({
        clock: {
          setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
          clear: (handle) => clearTimeout(handle),
        },
        now: () => Date.now(),
        onNotice: (message) => host.onNotice(message),
        ...(host.publishToConnection === undefined
          ? {}
          : {
              rebindMedia: async (
                source: HubSessionScope,
                target: HubSessionScope,
                epoch: string,
                generation: number,
                signal?: AbortSignal,
              ) => {
                await browserCommand(source, epoch, generation, 'detach', signal);
                await browserCommand(target, epoch, generation, 'attach', signal);
              },
              mediaReady: async (target: HubSessionScope, epoch: string, generation: number, signal?: AbortSignal) =>
                browserCommand(target, epoch, generation, 'ready', signal),
            }),
        send: async (scope, command: VoiceOwnershipCommand, signal?: AbortSignal) => {
          const response = await host.requestSessionApi(scope, {
            basePath: VOICE_MEDIA_API_BASE_PATH,
            path: VOICE_OWNERSHIP_ROUTES.command,
            method: 'POST',
            body: JSON.stringify(command),
            signal,
          });
          if (!response.ok) return undefined;
          return parseVoiceOwnershipAcknowledgement(await response.json());
        },
      });
      const submitTransfer = (scope: HubSessionScope, request: { requestId: string; handle: string }): void => {
        let requestIds = handledRequests.get(scope.sessionId);
        if (requestIds === undefined) {
          if (handledRequests.size >= MAX_HANDLED_REQUEST_SESSIONS) {
            const oldestSession = handledRequests.keys().next().value;
            if (oldestSession !== undefined) handledRequests.delete(oldestSession);
          }
          requestIds = new Set();
          handledRequests.set(scope.sessionId, requestIds);
        } else {
          handledRequests.delete(scope.sessionId);
          handledRequests.set(scope.sessionId, requestIds);
        }
        if (requestIds.has(request.requestId)) return;
        if (requestIds.size >= MAX_HANDLED_REQUEST_IDS_PER_SESSION) {
          const oldest = requestIds.values().next().value;
          if (oldest !== undefined) requestIds.delete(oldest);
        }
        requestIds.add(request.requestId);
        void coordinator.transfer(scope.sessionId, request.handle);
      };
      const poll = async (scope: HubSessionScope): Promise<void> => {
        if (polling.has(scope.sessionId)) return;
        polling.add(scope.sessionId);
        try {
          const response = await host.requestSessionApi(scope, {
            basePath: VOICE_MEDIA_API_BASE_PATH,
            path: VOICE_OWNERSHIP_ROUTES.state,
            method: 'GET',
          });
          if (!response.ok) return;
          const body = record(await response.json());
          const registration = parseVoiceOwnershipRegistration(body?.registration);
          if (registration === undefined) return;
          coordinator.update(scope, registration);
          const request = parseVoiceOwnershipTransferRequest(body?.request);
          if (request !== undefined) submitTransfer(scope, request);
        } catch (error) {
          host.onNotice(`voice ownership poll failed (${error instanceof Error ? error.message : String(error)})`);
        } finally {
          polling.delete(scope.sessionId);
        }
      };
      receive = (scope, payload, connectionId) => {
        const browser = parseBrowserVoiceOwnershipPayload(payload);
        if (browser?.type === 'browser-media-runtime') {
          mediaConnectionId ??= connectionId;
          return;
        }
        if (browser?.type === 'browser-media-ack') {
          const key = `${browser.epoch}:${browser.generation}:${browser.revision}:${browser.action}`;
          const pending = pendingBrowser.get(key);
          if (pending === undefined || pending.connectionId !== connectionId) return;
          pendingBrowser.delete(key);
          clearTimeout(pending.timeout);
          pending.resolve(browser);
          return;
        }
        const request = parseVoiceOwnershipTransferRequest(payload);
        if (request !== undefined) submitTransfer(scope, request);
      };
      disconnected = (connectionId) => {
        if (mediaConnectionId === connectionId) mediaConnectionId = undefined;
        for (const [key, pending] of pendingBrowser) {
          if (pending.connectionId !== connectionId) continue;
          pendingBrowser.delete(key);
          clearTimeout(pending.timeout);
          pending.reject(new Error('Browser media runtime disconnected.'));
        }
      };
      const timer = setInterval(() => {
        for (const scope of scopes.values()) void poll(scope);
      }, OWNERSHIP_POLL_MS);
      const source: HubChannelSource = {
        payloadFor(scope) {
          return latest.get(scope.sessionId);
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          sources.get(scope.sessionId)?.close();
          sources.set(
            scope.sessionId,
            watch(scope.sessionId, (wake) => {
              if (wake === undefined) {
                latest.delete(scope.sessionId);
                return;
              }
              latest.set(scope.sessionId, wake);
              host.publish(scope.sessionId, wake);
            }),
          );
          void poll(scope);
        },
        sessionRemoved(sessionId) {
          scopes.delete(sessionId);
          coordinator.remove(sessionId);
          sources.get(sessionId)?.close();
          sources.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          closed = true;
          mediaConnectionId = undefined;
          clearInterval(timer);
          receive = undefined;
          disconnected = undefined;
          for (const [key, pending] of pendingBrowser) {
            pendingBrowser.delete(key);
            clearTimeout(pending.timeout);
            pending.reject(new Error('Voice media channel closed.'));
          }
          for (const wakeSource of sources.values()) wakeSource.close();
          sources.clear();
          scopes.clear();
          handledRequests.clear();
          latest.clear();
        },
      };
      return source;
    },
    receive(scope, payload, connection) {
      receive?.(scope, payload, connection.connectionId);
    },
    disconnected(connection) {
      disconnected?.(connection.connectionId);
    },
  };
}

export const webHubChannels: readonly WebHubChannel[] = [createVoiceMediaWakeChannel()];
