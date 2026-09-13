import { type TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';

import {
  VOICE_RELOAD_HANDOFF_REGISTRY_KEY,
  VOICE_RELOAD_HANDOFF_TTL_MS,
  MAX_SESSION_ID_LENGTH,
  MAX_TOKEN_LENGTH,
} from '../../constants/voiceReloadHandoff';
import {
  type VoiceReloadHandoffKind,
  VoiceReloadHandoffIdentitySchema,
  type VoiceReloadHandoffIdentity,
  VoiceReloadHandoffRequestSchema,
  VoiceReloadHandoffSchema,
  type VoiceReloadHandoff,
} from '../../schemas/voiceReloadHandoff';
import { type VoiceToolSessionHandle } from '../voiceTools';

/** The sole exact global allowed for Voice continuity across module reload. */

const REGISTRY_SYMBOL = Symbol.for(VOICE_RELOAD_HANDOFF_REGISTRY_KEY);

export interface VoiceReloadHandoffRequest {
  readonly operationId: string;
  readonly kind?: VoiceReloadHandoffKind;
  readonly domains?: readonly string[];
  readonly majorMode?: string;
  readonly profile?: string;
}

export interface VoiceReloadHandoffHandle {
  readonly token: string;
  commit(): boolean;
  discard(): boolean;
}

export interface VoiceReloadHandoffRuntime {
  now(): number;
  createToken(): string;
}

export interface VoiceReloadHandoffStore {
  prepare(
    session: Pick<VoiceToolSessionHandle, 'active' | 'hostGeneration' | 'sessionId'>,
    request: VoiceReloadHandoffRequest,
  ): VoiceReloadHandoffHandle;
  accept(token: string, identity: VoiceReloadHandoffIdentity): VoiceReloadHandoff | undefined;
  commit(token: string, identity: VoiceReloadHandoffIdentity): boolean;
  discard(token: string, identity: VoiceReloadHandoffIdentity): boolean;
  /** The replacement generation consumes a committed record by stable session id. */
  consume(sessionId: string, token?: string): VoiceReloadHandoff | undefined;
}

export class VoiceReloadHandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceReloadHandoffError';
  }
}

interface PendingHandoff {
  readonly record: VoiceReloadHandoff;
  state: 'pending' | 'committed';
}

interface VoiceReloadHandoffRegistry {
  readonly records: Map<string, PendingHandoff>;
}

interface VoiceReloadHandoffGlobal {
  [REGISTRY_SYMBOL]?: VoiceReloadHandoffRegistry;
}

function registry(): VoiceReloadHandoffRegistry {
  const globalRegistry = globalThis as VoiceReloadHandoffGlobal;
  const existing = globalRegistry[REGISTRY_SYMBOL];
  if (existing) return existing;
  const created = { records: new Map<string, PendingHandoff>() };
  globalRegistry[REGISTRY_SYMBOL] = created;
  return created;
}

function validationError(label: string, schema: TSchema, value: unknown): VoiceReloadHandoffError {
  const [first] = Errors(schema, value);
  return new VoiceReloadHandoffError(
    `Invalid ${label}${first ? ` at ${first.instancePath || '/'}: ${first.message}` : ''}.`,
  );
}

function validateIdentity(identity: VoiceReloadHandoffIdentity): VoiceReloadHandoffIdentity {
  if (!Check(VoiceReloadHandoffIdentitySchema, identity)) {
    throw validationError('voice reload handoff identity', VoiceReloadHandoffIdentitySchema, identity);
  }
  return { sessionId: identity.sessionId, hostGeneration: identity.hostGeneration };
}

function validNow(runtime: VoiceReloadHandoffRuntime): number {
  const now = runtime.now();
  if (!Number.isInteger(now) || now < 0) throw new VoiceReloadHandoffError('Voice reload handoff clock is invalid.');
  return now;
}

function cloneRecord(record: VoiceReloadHandoff): VoiceReloadHandoff {
  return {
    ...record,
    domains: [...record.domains],
  };
}

function pruneExpired(now: number): void {
  for (const [token, pending] of registry().records) {
    if (pending.record.expiresAt <= now) registry().records.delete(token);
  }
}

function matchesIdentity(record: VoiceReloadHandoff, identity: VoiceReloadHandoffIdentity): boolean {
  return record.sessionId === identity.sessionId && record.hostGeneration === identity.hostGeneration;
}

/** Creates an accessor over the exact cross-reload registry with explicit time and token dependencies. */
export function createVoiceReloadHandoffStore(runtime: VoiceReloadHandoffRuntime): VoiceReloadHandoffStore {
  const store: VoiceReloadHandoffStore = {
    prepare(session, request) {
      const now = validNow(runtime);
      pruneExpired(now);
      if (!session.active) throw new VoiceReloadHandoffError('The voice session is no longer active.');
      const identity = validateIdentity({ sessionId: session.sessionId, hostGeneration: session.hostGeneration });
      if (!Check(VoiceReloadHandoffRequestSchema, request)) {
        throw validationError('voice reload handoff request', VoiceReloadHandoffRequestSchema, request);
      }
      const kind = request.kind ?? 'domain-switch';
      const domains = [...(request.domains ?? [])];
      if (kind === 'major-mode-switch' && request.majorMode === undefined) {
        throw new VoiceReloadHandoffError('Major-mode reload handoffs require a major mode.');
      }
      if (kind === 'profile-switch' && request.profile === undefined) {
        throw new VoiceReloadHandoffError('Profile reload handoffs require a profile.');
      }
      if (kind === 'domain-switch' && request.majorMode !== undefined) {
        throw new VoiceReloadHandoffError('Domain reload handoffs cannot include a major mode.');
      }
      if (kind === 'major-mode-switch' && domains.length > 0) {
        throw new VoiceReloadHandoffError('Major-mode reload handoffs cannot include domains.');
      }
      if (kind !== 'profile-switch' && request.profile !== undefined) {
        throw new VoiceReloadHandoffError('Only profile reload handoffs can include a profile.');
      }
      if (kind === 'profile-switch' && request.majorMode !== undefined) {
        throw new VoiceReloadHandoffError('Profile reload handoffs cannot include a major mode.');
      }
      if (kind === 'profile-switch' && domains.length > 0) {
        throw new VoiceReloadHandoffError('Profile reload handoffs cannot include domains.');
      }
      const token = `voice-reload:${runtime.createToken()}`;
      if (token.length > MAX_TOKEN_LENGTH || registry().records.has(token)) {
        throw new VoiceReloadHandoffError('Voice reload handoff token is invalid or already active.');
      }
      const record: VoiceReloadHandoff = {
        token,
        ...identity,
        operationId: request.operationId,
        kind,
        domains,
        ...(request.majorMode === undefined ? {} : { majorMode: request.majorMode }),
        ...(request.profile === undefined ? {} : { profile: request.profile }),
        createdAt: now,
        expiresAt: now + VOICE_RELOAD_HANDOFF_TTL_MS,
      };
      if (!Check(VoiceReloadHandoffSchema, record)) {
        throw validationError('voice reload handoff', VoiceReloadHandoffSchema, record);
      }
      registry().records.set(token, { record, state: 'pending' });
      let closed = false;
      return Object.freeze({
        token,
        commit() {
          if (closed) return false;
          closed = true;
          return store.commit(token, identity);
        },
        discard() {
          if (closed) return false;
          closed = true;
          return store.discard(token, identity);
        },
      });
    },
    accept(token, identity) {
      const now = validNow(runtime);
      pruneExpired(now);
      const validatedIdentity = validateIdentity(identity);
      const pending = registry().records.get(token);
      if (!pending || pending.state !== 'pending' || !matchesIdentity(pending.record, validatedIdentity)) {
        return undefined;
      }
      pending.state = 'committed';
      return cloneRecord(pending.record);
    },
    commit(token, identity) {
      return store.accept(token, identity) !== undefined;
    },
    discard(token, identity) {
      const now = validNow(runtime);
      pruneExpired(now);
      const validatedIdentity = validateIdentity(identity);
      const pending = registry().records.get(token);
      if (!pending || !matchesIdentity(pending.record, validatedIdentity)) return false;
      return registry().records.delete(token);
    },
    consume(sessionId, token) {
      const now = validNow(runtime);
      pruneExpired(now);
      if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
        throw new VoiceReloadHandoffError('Voice reload handoff session id is invalid.');
      }
      const candidates = [...registry().records.entries()]
        .filter(
          ([candidateToken, pending]) =>
            pending.state === 'committed' &&
            pending.record.sessionId === sessionId &&
            (token === undefined || candidateToken === token),
        )
        .sort((left, right) => right[1].record.createdAt - left[1].record.createdAt);
      const [candidate] = candidates;
      if (!candidate) return undefined;
      registry().records.delete(candidate[0]);
      return cloneRecord(candidate[1].record);
    },
  };
  return Object.freeze(store);
}
