import type { HubChannelSource, HubSessionScope, WebHubChannel } from '@agimon-ai/doompi-web-contracts';
import { VoiceOwnershipCoordinator } from '../services/voiceOwnershipCoordinator.ts';
import { VOICE_MEDIA_API_BASE_PATH, VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../types/clientMedia.ts';
import {
  VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS,
  VOICE_OWNERSHIP_FRAME_TYPE,
  VOICE_OWNERSHIP_ROUTES,
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipActivationRequest,
  parseVoiceOwnershipHandoffRequest,
  parseVoiceOwnershipRegistration,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipCommand,
} from '../types/voiceOwnership.ts';
import { type VoiceMediaWakeSource, watchVoiceMediaWake } from './voiceMediaWakeFile.ts';

const OWNERSHIP_POLL_MS = 1_000;
const MAX_HANDLED_REQUESTS = 512;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createVoiceMediaWakeChannel(watch: typeof watchVoiceMediaWake = watchVoiceMediaWake): WebHubChannel {
  return {
    frameType: VOICE_MEDIA_WAKE_TYPE,
    start(host) {
      const latest = new Map<string, VoiceMediaWake>();
      const sources = new Map<string, VoiceMediaWakeSource>();
      return {
        payloadFor(scope) {
          return latest.get(scope.sessionId);
        },
        sessionAdded(scope) {
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
        },
        sessionRemoved(sessionId) {
          sources.get(sessionId)?.close();
          sources.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const source of sources.values()) source.close();
          sources.clear();
          latest.clear();
        },
      };
    },
  };
}

export function createVoiceOwnershipChannel(options: { pollMs?: number } = {}): WebHubChannel {
  return {
    frameType: VOICE_OWNERSHIP_FRAME_TYPE,
    lifecycle: 'hub',
    start(host) {
      const scopes = new Map<string, HubSessionScope>();
      const handledRequests = new Set<string>();
      let closed = false;
      let polling = false;
      let catalogSignature = '';

      const publishSelection = (payload: BrowserVoiceOwnershipPayload): void => {
        for (const scope of scopes.values()) host.publish(scope.sessionId, payload);
      };

      const sendCommand = async (sessionId: string, command: VoiceOwnershipCommand) => {
        const scope = scopes.get(sessionId);
        if (scope === undefined) throw new Error(`Voice session ${sessionId} is unavailable.`);
        const response = await host.requestSessionApi(scope, {
          basePath: VOICE_MEDIA_API_BASE_PATH,
          path: VOICE_OWNERSHIP_ROUTES.command,
          method: 'POST',
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS),
        });
        const acknowledgement = response.ok ? parseVoiceOwnershipAcknowledgement(await response.json()) : undefined;
        if (acknowledgement === undefined)
          throw new Error(`Voice ownership command failed with HTTP ${response.status}.`);
        return acknowledgement;
      };

      const coordinator = new VoiceOwnershipCoordinator({ send: sendCommand }, publishSelection, {
        now: () => Date.now(),
        createId: () => globalThis.crypto.randomUUID(),
      });

      const remember = (key: string): boolean => {
        if (handledRequests.has(key)) return false;
        handledRequests.add(key);
        if (handledRequests.size > MAX_HANDLED_REQUESTS) {
          const oldest = handledRequests.values().next().value;
          if (oldest !== undefined) handledRequests.delete(oldest);
        }
        return true;
      };

      const refreshCatalogs = async (): Promise<void> => {
        const nextSignature = [...scopes.keys()]
          .sort((left, right) => left.localeCompare(right))
          .map((sessionId) => `${sessionId}:${JSON.stringify(coordinator.catalog(sessionId))}`)
          .join('|');
        if (nextSignature === catalogSignature) return;
        await coordinator.publishCatalogs();
        catalogSignature = nextSignature;
      };

      const poll = async (): Promise<void> => {
        if (closed || polling) return;
        polling = true;
        try {
          const snapshots: Array<{
            sessionId: string;
            activation: ReturnType<typeof parseVoiceOwnershipActivationRequest>;
            handoff: ReturnType<typeof parseVoiceOwnershipHandoffRequest>;
          }> = [];
          for (const scope of scopes.values()) {
            try {
              const response = await host.requestSessionApi(scope, {
                basePath: VOICE_MEDIA_API_BASE_PATH,
                path: VOICE_OWNERSHIP_ROUTES.state,
                method: 'GET',
              });
              const body = response.ok ? record(await response.json()) : undefined;
              const registration = parseVoiceOwnershipRegistration(body?.registration);
              if (registration === undefined) {
                coordinator.remove(scope.sessionId);
                continue;
              }
              coordinator.update(scope.sessionId, registration);
              snapshots.push({
                sessionId: scope.sessionId,
                activation: parseVoiceOwnershipActivationRequest(body?.activation),
                handoff: parseVoiceOwnershipHandoffRequest(body?.handoff),
              });
            } catch (error) {
              coordinator.remove(scope.sessionId);
              host.onNotice(
                `voice ownership poll failed for ${scope.sessionId} (${error instanceof Error ? error.message : String(error)})`,
              );
            }
          }

          try {
            await refreshCatalogs();
          } catch (error) {
            host.onNotice(
              `voice ownership catalog update failed (${error instanceof Error ? error.message : String(error)})`,
            );
          }

          for (const snapshot of snapshots) {
            if (snapshot.handoff !== undefined) {
              const key = `${snapshot.sessionId}:handoff:${snapshot.handoff.requestId}`;
              if (remember(key)) {
                try {
                  if (!(await coordinator.handoff(snapshot.sessionId, snapshot.handoff.handle)))
                    host.onNotice(`voice handoff requested by ${snapshot.sessionId} was rejected`);
                } catch (error) {
                  host.onNotice(
                    `voice handoff requested by ${snapshot.sessionId} failed (${error instanceof Error ? error.message : String(error)})`,
                  );
                }
              }
              continue;
            }
            if (snapshot.activation !== undefined) {
              const key = `${snapshot.sessionId}:activate:${snapshot.activation.requestId}`;
              if (remember(key)) {
                try {
                  if (!(await coordinator.activate(snapshot.sessionId)))
                    host.onNotice(`voice activation requested by ${snapshot.sessionId} was rejected`);
                } catch (error) {
                  host.onNotice(
                    `voice activation requested by ${snapshot.sessionId} failed (${error instanceof Error ? error.message : String(error)})`,
                  );
                }
              }
            }
          }
        } finally {
          polling = false;
        }
      };

      const timer = setInterval(() => void poll(), options.pollMs ?? OWNERSHIP_POLL_MS);
      const source: HubChannelSource = {
        payloadFor() {
          return coordinator.payload();
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          void poll();
        },
        sessionRemoved(sessionId) {
          scopes.delete(sessionId);
          coordinator.remove(sessionId);
          catalogSignature = '';
        },
        close() {
          closed = true;
          clearInterval(timer);
          scopes.clear();
          handledRequests.clear();
        },
      };
      return source;
    },
  };
}

export const webHubChannels: readonly WebHubChannel[] = [createVoiceMediaWakeChannel(), createVoiceOwnershipChannel()];
