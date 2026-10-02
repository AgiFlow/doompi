import type { DoomHubChannel, DoomHubChannelSource, DoomHubSessionScope } from '@agimon-ai/doompi-core/hubChannel';
import { parseRemoteSessionReference } from '@agimon-ai/doompi-session';

import { VoiceOwnershipCoordinator } from '../../services/voiceOwnershipCoordinator';
import {
  discoverPairedVoiceTargets,
  registerVoicePeerOwnership,
  sendPairedVoiceOwnershipCommand,
} from '../../services/voicePeerRelay';
import { VOICE_MEDIA_API_BASE_PATH, VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../../types/clientMedia';
import {
  VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS,
  VOICE_OWNERSHIP_FRAME_TYPE,
  VOICE_OWNERSHIP_ROUTES,
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipSessionSnapshot,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipCommand,
  type VoiceOwnershipSessionSnapshot,
} from '../../types/voiceOwnership';

const MAX_HANDLED_REQUESTS = 512;
const MAX_EVENT_EPOCH_LENGTH = 200;
const CATALOG_RETRY_BASE_MS = 1_000;
const CATALOG_RETRY_MAX_MS = 30_000;

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
export function createVoiceOwnershipChannel(
  onStart?: (coordinator: VoiceOwnershipCoordinator) => void,
  onClose?: () => void,
  onCatalogChange?: (coordinator: VoiceOwnershipCoordinator) => void,
): DoomHubChannel {
  return {
    frameType: VOICE_OWNERSHIP_FRAME_TYPE,
    lifecycle: 'hub',
    start(host) {
      const scopes = new Map<string, DoomHubSessionScope>();
      const subscriptions = new Map<string, () => void>();
      const handledRequests = new Set<string>();
      const localRegistrations = new Map<string, NonNullable<VoiceOwnershipSessionSnapshot['registration']>>();
      const remoteSessions = new Set<string>();
      // Per-session delivery state, so one failing participant neither blocks nor re-floods the rest.
      const deliveredCatalogs = new Map<string, string>();
      const catalogRetries = new Map<string, { failures: number; retryAt: number }>();
      let catalogRun: Promise<void> | undefined;
      let peerRefreshTimer: ReturnType<typeof setInterval> | undefined;

      const publishSelection = (payload: BrowserVoiceOwnershipPayload): void => {
        for (const scope of scopes.values()) host.publish(scope.sessionId, payload);
      };

      const sendCommand = async (sessionId: string, command: VoiceOwnershipCommand) => {
        if (parseRemoteSessionReference(sessionId) !== undefined)
          return sendPairedVoiceOwnershipCommand(sessionId, command);
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
      onStart?.(coordinator);
      const unregisterPeerOwnership = registerVoicePeerOwnership({
        discover: () => [...localRegistrations].map(([sessionId, registration]) => ({ sessionId, registration })),
        command: (sessionId, command) => sendCommand(sessionId, command),
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

      const refreshRemoteTargets = async (): Promise<void> => {
        const discovered = await discoverPairedVoiceTargets();
        const next = new Set(discovered.map((target) => target.sessionId));
        for (const sessionId of remoteSessions) if (!next.has(sessionId)) coordinator.remove(sessionId);
        remoteSessions.clear();
        for (const target of discovered) {
          remoteSessions.add(target.sessionId);
          coordinator.update(target.sessionId, target.registration);
        }
      };

      const publishCatalogsOnce = async (): Promise<void> => {
        await refreshRemoteTargets();
        const nextSignature = [...scopes.keys()]
          .sort((left, right) => left.localeCompare(right))
          .map((sessionId) => `${sessionId}:${JSON.stringify(coordinator.catalog(sessionId))}`)
          .join('|');
        const now = Date.now();
        const pending = [...scopes.keys()].filter(
          (sessionId) =>
            deliveredCatalogs.get(sessionId) !== nextSignature &&
            coordinator.registration(sessionId) !== undefined &&
            (catalogRetries.get(sessionId)?.retryAt ?? 0) <= now,
        );
        if (pending.length === 0) return;
        const failures = await coordinator.publishCatalogs(pending);
        const failed = new Set(failures.map((failure) => failure.sessionId));
        for (const sessionId of pending) {
          if (!scopes.has(sessionId)) continue;
          if (!failed.has(sessionId)) {
            deliveredCatalogs.set(sessionId, nextSignature);
            catalogRetries.delete(sessionId);
            continue;
          }
          const attempts = (catalogRetries.get(sessionId)?.failures ?? 0) + 1;
          const delay = Math.min(CATALOG_RETRY_BASE_MS * 2 ** (attempts - 1), CATALOG_RETRY_MAX_MS);
          catalogRetries.set(sessionId, { failures: attempts, retryAt: Date.now() + delay });
        }
        if (failed.size < pending.length) onCatalogChange?.(coordinator);
        if (failures.length > 0)
          throw new Error(
            failures
              .map(({ sessionId, error }) => `${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
              .join('; '),
          );
      };

      /**
       * Serialises overlapping catalog refreshes so concurrent callers cannot both pass the
       * signature guard and publish the same state twice. Waiters do not share the in-flight run:
       * each takes its own turn afterwards and the signature guard in publishCatalogsOnce makes
       * that turn a no-op unless the state actually changed mid-flight, which is the trailing edge.
       */
      const refreshCatalogs = async (): Promise<void> => {
        // The run in flight reports its own failure to its own caller; a waiter only needs its turn.
        while (catalogRun !== undefined) await catalogRun.catch(() => undefined);
        const run = publishCatalogsOnce();
        catalogRun = run;
        try {
          await run;
        } finally {
          if (catalogRun === run) catalogRun = undefined;
        }
      };

      const processSnapshot = async (sessionId: string, snapshot: VoiceOwnershipSessionSnapshot): Promise<void> => {
        if (snapshot.handoff !== undefined) {
          const key = `${sessionId}:handoff:${snapshot.handoff.requestId}`;
          if (!remember(key)) return;
          try {
            if (!(await coordinator.handoff(sessionId, snapshot.handoff.handle, snapshot.handoff.catalogRevision)))
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

      const applySnapshot = (sessionId: string, value: unknown, replayed = false): void => {
        const snapshot = parseVoiceOwnershipSessionSnapshot(value);
        if (snapshot?.registration === undefined) {
          localRegistrations.delete(sessionId);
          coordinator.remove(sessionId);
          void refreshCatalogs().catch((error: unknown) =>
            host.onNotice(
              `voice ownership catalog update failed (${error instanceof Error ? error.message : String(error)})`,
            ),
          );
          return;
        }
        // A replayed snapshot has no age and would renew the lease of a stopped runtime.
        // Live runtimes republish on every sync, so only fresh snapshots register.
        if (replayed) return;
        localRegistrations.set(sessionId, snapshot.registration);
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
          let replaying = true;
          const unsubscribe = host.directEvents.subscribe(
            VOICE_OWNERSHIP_FRAME_TYPE,
            scope.sessionId,
            (payload) => applySnapshot(scope.sessionId, payload, replaying),
            { replayLatest: true },
          );
          replaying = false;
          subscriptions.set(scope.sessionId, unsubscribe);
          void refreshCatalogs().catch((error: unknown) =>
            host.onNotice(
              `voice ownership catalog update failed (${error instanceof Error ? error.message : String(error)})`,
            ),
          );
          if (peerRefreshTimer === undefined) {
            peerRefreshTimer = setInterval(() => {
              void refreshCatalogs().catch((error: unknown) =>
                host.onNotice(
                  `voice ownership peer refresh failed (${error instanceof Error ? error.message : String(error)})`,
                ),
              );
            }, 5_000);
            peerRefreshTimer.unref?.();
          }
        },
        sessionRemoved(sessionId) {
          subscriptions.get(sessionId)?.();
          subscriptions.delete(sessionId);
          scopes.delete(sessionId);
          localRegistrations.delete(sessionId);
          coordinator.remove(sessionId);
          deliveredCatalogs.clear();
          catalogRetries.delete(sessionId);
        },
        close() {
          for (const unsubscribe of subscriptions.values()) unsubscribe();
          subscriptions.clear();
          scopes.clear();
          localRegistrations.clear();
          remoteSessions.clear();
          handledRequests.clear();
          deliveredCatalogs.clear();
          catalogRetries.clear();
          if (peerRefreshTimer !== undefined) clearInterval(peerRefreshTimer);
          peerRefreshTimer = undefined;
          unregisterPeerOwnership();
          onClose?.();
        },
      };
      return source;
    },
  };
}
