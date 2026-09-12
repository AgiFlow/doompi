import type { DoomHubChannel, DoomHubChannelSource, DoomHubSessionScope } from '@agimon-ai/doompi-core/hub-channel';
import { VoiceOwnershipCoordinator } from '../services/voiceOwnershipCoordinator';
import { VOICE_MEDIA_API_BASE_PATH, VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../types/clientMedia';
import {
  VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS,
  VOICE_OWNERSHIP_FRAME_TYPE,
  VOICE_OWNERSHIP_ROUTES,
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipSessionSnapshot,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipCommand,
  type VoiceOwnershipSessionSnapshot,
} from '../types/voiceOwnership';

const MAX_HANDLED_REQUESTS = 512;
const MAX_EVENT_EPOCH_LENGTH = 200;

function parseVoiceMediaWake(value: unknown): VoiceMediaWake | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'eventEpoch,sequence' ||
    typeof record.eventEpoch !== 'string' ||
    record.eventEpoch.length === 0 ||
    record.eventEpoch.length > MAX_EVENT_EPOCH_LENGTH ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0
  )
    return undefined;
  return { eventEpoch: record.eventEpoch, sequence: record.sequence as number };
}

/** Publishes session-owned media wakeups through the host's direct event bus. */
export function createVoiceMediaWakeChannel(): DoomHubChannel {
  return {
    frameType: VOICE_MEDIA_WAKE_TYPE,
    start(host) {
      const latest = new Map<string, VoiceMediaWake>();
      const subscriptions = new Map<string, () => void>();
      return {
        payloadFor(scope) {
          return latest.get(scope.sessionId);
        },
        sessionAdded(scope) {
          subscriptions.get(scope.sessionId)?.();
          const unsubscribe = host.directEvents.subscribe(
            VOICE_MEDIA_WAKE_TYPE,
            scope.sessionId,
            (payload) => {
              const wake = parseVoiceMediaWake(payload);
              if (wake === undefined) return;
              const current = latest.get(scope.sessionId);
              if (current?.eventEpoch === wake.eventEpoch && wake.sequence <= current.sequence) return;
              latest.set(scope.sessionId, wake);
              host.publish(scope.sessionId, wake);
            },
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          latest.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          latest.clear();
        },
      } satisfies DoomHubChannelSource;
    },
  };
}

/** Coordinates browser voice ownership from session lifecycle events. */
export function createVoiceOwnershipChannel(): DoomHubChannel {
  return {
    frameType: VOICE_OWNERSHIP_FRAME_TYPE,
    lifecycle: 'hub',
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const subscriptions = new Map<string, () => void>();
      const handledRequests = new Set<string>();
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

      const processSnapshot = async (sessionId: string, snapshot: VoiceOwnershipSessionSnapshot): Promise<void> => {
        if (snapshot.handoff !== undefined) {
          const key = `${sessionId}:handoff:${snapshot.handoff.requestId}`;
          if (!remember(key)) return;
          try {
            if (!(await coordinator.handoff(sessionId, snapshot.handoff.handle)))
              host.onNotice(`voice handoff requested by ${sessionId} was rejected`);
          } catch (error) {
            host.onNotice(
              `voice handoff requested by ${sessionId} failed (${error instanceof Error ? error.message : String(error)})`,
            );
          }
          return;
        }
        if (snapshot.activation === undefined) return;
        const key = `${sessionId}:activate:${snapshot.activation.requestId}`;
        if (!remember(key)) return;
        try {
          if (!(await coordinator.activate(sessionId)))
            host.onNotice(`voice activation requested by ${sessionId} was rejected`);
        } catch (error) {
          host.onNotice(
            `voice activation requested by ${sessionId} failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      };

      const applySnapshot = (sessionId: string, value: unknown): void => {
        const snapshot = parseVoiceOwnershipSessionSnapshot(value);
        if (snapshot?.registration === undefined) {
          coordinator.remove(sessionId);
          void refreshCatalogs().catch((error: unknown) =>
            host.onNotice(
              `voice ownership catalog update failed (${error instanceof Error ? error.message : String(error)})`,
            ),
          );
          return;
        }
        coordinator.update(sessionId, snapshot.registration);
        void processSnapshot(sessionId, snapshot);
        void refreshCatalogs().catch((error: unknown) =>
          host.onNotice(
            `voice ownership catalog update failed (${error instanceof Error ? error.message : String(error)})`,
          ),
        );
      };

      const source: DoomHubChannelSource = {
        payloadFor() {
          return coordinator.payload();
        },
        sessionAdded(scope) {
          scopes.set(scope.sessionId, scope);
          subscriptions.get(scope.sessionId)?.();
          const unsubscribe = host.directEvents.subscribe(
            VOICE_OWNERSHIP_FRAME_TYPE,
            scope.sessionId,
            (payload) => applySnapshot(scope.sessionId, payload),
            { replayLatest: true },
          );
          subscriptions.set(scope.sessionId, unsubscribe);
          void refreshCatalogs().catch((error: unknown) =>
            host.onNotice(
              `voice ownership catalog update failed (${error instanceof Error ? error.message : String(error)})`,
            ),
          );
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          scopes.delete(sessionId);
          coordinator.remove(sessionId);
          catalogSignature = '';
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          scopes.clear();
          handledRequests.clear();
        },
      };
      return source;
    },
  };
}
