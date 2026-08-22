import type {
  DomainSwitchHandoff,
  DomainSwitchHandoffIdentity,
  DomainSwitchHandoffRequest,
  DomainSwitchHandoffStore,
} from '../types/handoff.ts';
import { SAFE_DOMAIN_NAME } from '../types/domains.ts';

const DOMAIN_SWITCH_HANDOFF_REGISTRY_KEY = '@agimon-ai/doompi-domain.switch-handoff.v1';
const DOMAIN_SWITCH_HANDOFF_SYMBOL = Symbol.for(DOMAIN_SWITCH_HANDOFF_REGISTRY_KEY);
const DOMAIN_SWITCH_TOKEN_PREFIX = 'doom-domain-switch:';

export const DOMAIN_SWITCH_HANDOFF_TTL_MS = 30_000;
export const DOMAIN_SWITCH_HANDOFF_MAX_DOMAINS = 32;
export const DOMAIN_SWITCH_HANDOFF_MAX_IDENTIFIER_LENGTH = 256;
export const DOMAIN_SWITCH_HANDOFF_MAX_OPERATION_LENGTH = 128;

interface StoredDomainSwitchHandoff extends DomainSwitchHandoff {
  readonly ownerGeneration: string;
}

interface HandoffRegistry {
  readonly records: Map<string, StoredDomainSwitchHandoff>;
}

type HandoffGlobal = typeof globalThis & { [DOMAIN_SWITCH_HANDOFF_SYMBOL]?: HandoffRegistry };

/**
 * One registry per process, keyed by a well-known symbol.
 *
 * Pi can reload this module in place, and a reload that lost the parked handoffs
 * would strand the follow-up command the voice tool already sent. Ownership is
 * tracked per store instead, so a disposed store takes only its own records.
 */
function registry(): HandoffRegistry {
  const root = globalThis as HandoffGlobal;
  return (root[DOMAIN_SWITCH_HANDOFF_SYMBOL] ??= { records: new Map() });
}

function invalid(label: string): Error {
  return new Error(`Invalid domain switch handoff ${label}.`);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function normalized(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum || hasControlCharacter(text) || (pattern && !pattern.test(text))) {
    throw invalid(label);
  }
  return text;
}

function sessionId(value: string): string {
  return normalized(value, 'session id', DOMAIN_SWITCH_HANDOFF_MAX_IDENTIFIER_LENGTH);
}

function hostGeneration(value: string): string {
  return normalized(value, 'host generation', DOMAIN_SWITCH_HANDOFF_MAX_IDENTIFIER_LENGTH);
}

function operationId(value: string): string {
  return normalized(value, 'operation id', DOMAIN_SWITCH_HANDOFF_MAX_OPERATION_LENGTH, SAFE_DOMAIN_NAME);
}

function reloadToken(value: string): string {
  return normalized(value, 'reload handoff token', DOMAIN_SWITCH_HANDOFF_MAX_IDENTIFIER_LENGTH, SAFE_DOMAIN_NAME);
}

function token(value: string): string {
  return normalized(value, 'token', DOMAIN_SWITCH_HANDOFF_MAX_IDENTIFIER_LENGTH, SAFE_DOMAIN_NAME);
}

function domains(values: readonly string[]): string[] {
  if (values.length > DOMAIN_SWITCH_HANDOFF_MAX_DOMAINS) {
    throw new Error(`A maximum of ${DOMAIN_SWITCH_HANDOFF_MAX_DOMAINS} domains may be selected.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = normalized(value, 'domain name', DOMAIN_SWITCH_HANDOFF_MAX_OPERATION_LENGTH, SAFE_DOMAIN_NAME);
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function prune(now = Date.now()): void {
  for (const [key, record] of registry().records) {
    if (record.expiresAt <= now) registry().records.delete(key);
  }
}

function identityMatches(record: DomainSwitchHandoff, identity: DomainSwitchHandoffIdentity): boolean {
  if (record.sessionId !== sessionId(identity.sessionId)) return false;
  return record.hostGeneration === hostGeneration(identity.hostGeneration);
}

function copy(record: DomainSwitchHandoff): DomainSwitchHandoff {
  return { ...record, domains: [...record.domains] };
}

function issue(ownerGeneration: string, request: DomainSwitchHandoffRequest): DomainSwitchHandoff {
  prune();
  const normalizedSessionId = sessionId(request.sessionId);
  const normalizedHostGeneration = hostGeneration(request.hostGeneration);
  const normalizedOperationId = operationId(request.operationId);
  const normalizedDomains = domains(request.domains);
  const normalizedReloadToken = reloadToken(request.reloadHandoffToken);
  const createdAt = Date.now();
  const record: StoredDomainSwitchHandoff = {
    token: `${DOMAIN_SWITCH_TOKEN_PREFIX}${crypto.randomUUID()}`,
    sessionId: normalizedSessionId,
    hostGeneration: normalizedHostGeneration,
    operationId: normalizedOperationId,
    domains: normalizedDomains,
    reloadHandoffToken: normalizedReloadToken,
    createdAt,
    expiresAt: createdAt + DOMAIN_SWITCH_HANDOFF_TTL_MS,
    ownerGeneration,
  };
  registry().records.set(record.token, record);
  return copy(record);
}

function consume(identity: DomainSwitchHandoffIdentity, handoffToken: string): DomainSwitchHandoff | undefined {
  prune();
  const normalizedToken = token(handoffToken);
  const record = registry().records.get(normalizedToken);
  if (!record || !identityMatches(record, identity)) return undefined;
  registry().records.delete(normalizedToken);
  if (record.expiresAt <= Date.now()) return undefined;
  return copy(record);
}

function discard(identity: DomainSwitchHandoffIdentity, handoffToken: string): boolean {
  prune();
  const normalizedToken = token(handoffToken);
  const record = registry().records.get(normalizedToken);
  if (!record || !identityMatches(record, identity)) return false;
  return registry().records.delete(normalizedToken);
}

function clearOwnedSession(ownerGeneration: string, requestedSessionId: string): number {
  prune();
  const normalizedSessionId = sessionId(requestedSessionId);
  let removed = 0;
  for (const [key, record] of registry().records) {
    if (record.ownerGeneration !== ownerGeneration || record.sessionId !== normalizedSessionId) continue;
    registry().records.delete(key);
    removed += 1;
  }
  return removed;
}

function disposeOwner(ownerGeneration: string): number {
  let removed = 0;
  for (const [key, record] of registry().records) {
    if (record.ownerGeneration !== ownerGeneration) continue;
    registry().records.delete(key);
    removed += 1;
  }
  return removed;
}

export function createDomainSwitchHandoffStore(): DomainSwitchHandoffStore {
  const ownerGeneration = crypto.randomUUID();
  let disposed = false;
  return {
    ownerGeneration,
    issue(request) {
      if (disposed) throw new Error('Domain switch handoff store is disposed.');
      return issue(ownerGeneration, request);
    },
    consume(handoffToken, identity) {
      if (disposed) return undefined;
      return consume(identity, handoffToken);
    },
    discard(handoffToken, identity) {
      if (disposed) return false;
      return discard(identity, handoffToken);
    },
    clearSession(requestedSessionId) {
      if (disposed) return 0;
      return clearOwnedSession(ownerGeneration, requestedSessionId);
    },
    dispose() {
      if (disposed) return 0;
      disposed = true;
      return disposeOwner(ownerGeneration);
    },
  };
}
