import { peerSessionReference } from '../peerTransport';
import type {
  DiscoveredSession,
  SessionDirectory,
  SessionDirectoryOptions,
  SessionPresenceFacts,
  SessionPresenceObservation,
} from './type';

const UNKNOWN_FACTS: SessionPresenceFacts = Object.freeze({
  reachability: 'unknown',
  runtime: 'unknown',
  activity: 'unknown',
  voice: Object.freeze({ eligible: 'unknown', readiness: 'unknown' }),
});

function keyOf(observation: Pick<SessionPresenceObservation, 'hostId' | 'sessionId'>): string {
  return peerSessionReference(observation.hostId, observation.sessionId);
}

function publicEntry(
  observation: SessionPresenceObservation,
  now: number,
  label: string | undefined,
  capabilities: readonly string[],
): DiscoveredSession {
  const freshUntil = observation.observedAt + observation.staleAfterMs;
  const fresh = now <= freshUntil;
  const facts: SessionPresenceFacts = fresh ? observation : UNKNOWN_FACTS;
  return Object.freeze({
    reference: keyOf(observation),
    ...(label === undefined ? {} : { label }),
    capabilities: Object.freeze([...capabilities]),
    hostIncarnation: observation.hostIncarnation,
    sessionIncarnation: observation.sessionIncarnation,
    sequence: observation.sequence,
    observedAt: observation.observedAt,
    freshUntil,
    fresh,
    reachability: facts.reachability,
    runtime: facts.runtime,
    activity: facts.activity,
    voice: Object.freeze({ ...facts.voice }),
  });
}

/** In-memory authenticated presence cache. Restart deliberately forgets every observation. */
export function createSessionDirectory(options: SessionDirectoryOptions): SessionDirectory {
  const now = options.now ?? Date.now;
  const observations = new Map<string, SessionPresenceObservation>();
  const snapshotRequired = new Set<string>();
  const subscribers = new Set<{
    callerReference: string;
    listener: (sessions: readonly DiscoveredSession[]) => void;
  }>();

  const discover = (callerReference: string, allowedReferences?: ReadonlySet<string>): readonly DiscoveredSession[] => {
    const result: DiscoveredSession[] = [];
    for (const observation of observations.values()) {
      const reference = keyOf(observation);
      if (allowedReferences && !allowedReferences.has(reference)) continue;
      const grant = options.authorizeDiscovery(callerReference, observation);
      if (!grant) continue;
      result.push(publicEntry(observation, now(), grant.label ?? observation.label, grant.capabilities));
    }
    return result.sort((left, right) => left.reference.localeCompare(right.reference));
  };
  const notify = (): void => {
    for (const subscriber of subscribers) subscriber.listener(discover(subscriber.callerReference));
  };

  return {
    observe(observation) {
      const key = keyOf(observation);
      const current = observations.get(key);
      if (snapshotRequired.has(observation.hostId)) return false;
      if (current?.hostIncarnation === observation.hostIncarnation) {
        if (current.sessionIncarnation === observation.sessionIncarnation && observation.sequence <= current.sequence)
          return false;
        if (observation.sequence !== current.sequence + 1) {
          snapshotRequired.add(observation.hostId);
          for (const [reference, candidate] of observations)
            if (candidate.hostId === observation.hostId)
              observations.set(reference, { ...candidate, ...UNKNOWN_FACTS, observedAt: now(), staleAfterMs: 0 });
          notify();
          return false;
        }
      }
      observations.set(key, Object.freeze({ ...observation, voice: Object.freeze({ ...observation.voice }) }));
      notify();
      return true;
    },
    replaceHostSnapshot(hostId, hostIncarnation, replacements) {
      if (
        replacements.some(
          (observation) => observation.hostId !== hostId || observation.hostIncarnation !== hostIncarnation,
        )
      ) {
        throw new TypeError('A presence snapshot must contain only the declared host incarnation.');
      }
      for (const [reference, observation] of observations)
        if (observation.hostId === hostId) observations.delete(reference);
      for (const observation of replacements)
        observations.set(
          keyOf(observation),
          Object.freeze({ ...observation, voice: Object.freeze({ ...observation.voice }) }),
        );
      snapshotRequired.delete(hostId);
      notify();
    },
    hostDisconnected(hostId) {
      for (const [reference, observation] of observations) {
        if (observation.hostId !== hostId) continue;
        observations.set(reference, { ...observation, reachability: 'unreachable' });
      }
      notify();
    },
    discover,
    resolveDeliveryTarget(callerReference, reference) {
      const observation = observations.get(reference);
      return observation && options.authorizeDiscovery(callerReference, observation)
        ? observation.deliveryTarget
        : undefined;
    },
    subscribe(callerReference, listener) {
      const subscriber = { callerReference, listener };
      subscribers.add(subscriber);
      listener(discover(callerReference));
      return () => subscribers.delete(subscriber);
    },
  };
}

export type {
  DiscoveredSession,
  SessionActivityState,
  SessionDirectory,
  SessionDirectoryOptions,
  SessionDiscoveryGrant,
  SessionHostReachability,
  SessionPresenceFacts,
  SessionPresenceObservation,
  SessionRuntimeState,
  SessionVoiceReadiness,
} from './type';
