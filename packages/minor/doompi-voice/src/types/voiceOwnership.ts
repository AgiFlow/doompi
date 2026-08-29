export const VOICE_OWNERSHIP_PROTOCOL_VERSION = 2;
export const VOICE_OWNERSHIP_LEASE_MS = 15_000;
/**
 * Ownership transitions include autonomous startup, whose worker handshake may
 * legitimately take 21 seconds. Keep command delivery above that bound so the
 * hub does not reject a transition that is still completing.
 */
export const VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS = 30_000;
export const VOICE_OWNERSHIP_MAX_TARGETS = 32;
export const VOICE_OWNERSHIP_FRAME_TYPE = 'voice_ownership';
export const VOICE_OWNERSHIP_ROUTES = {
  state: '/hub/ownership/state',
  command: '/hub/ownership/command',
  sync: '/host/ownership/sync',
} as const;

export type VoiceOwnershipAction = 'catalog' | 'activate' | 'deactivate';

export interface VoiceOwnershipRegistration {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  leaseId: string;
  revision: number;
  label: string;
  eligible: boolean;
  active: boolean;
}

export interface VoiceOwnershipTarget {
  handle: string;
  label: string;
  order: number;
}

export interface VoiceOwnershipCommand {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  commandId: string;
  action: VoiceOwnershipAction;
  targets?: VoiceOwnershipTarget[];
}

export interface VoiceOwnershipAcknowledgement {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  commandId: string;
  action: VoiceOwnershipAction;
  ok: boolean;
  active: boolean;
  error?: string;
}

export interface VoiceOwnershipActivationRequest {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  requestId: string;
}

export interface VoiceOwnershipHandoffRequest {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  requestId: string;
  handle: string;
}

export interface VoiceOwnershipSessionSnapshot {
  registration?: VoiceOwnershipRegistration;
  targets: VoiceOwnershipTarget[];
  activation?: VoiceOwnershipActivationRequest;
  handoff?: VoiceOwnershipHandoffRequest;
  acknowledgement?: VoiceOwnershipAcknowledgement;
}

export interface BrowserVoiceOwnershipPayload {
  type: 'browser-media-session';
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  activeSessionId: string | null;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function id(value: unknown, maximum = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && ID_PATTERN.test(value);
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function action(value: unknown): value is VoiceOwnershipAction {
  return value === 'catalog' || value === 'activate' || value === 'deactivate';
}

export function parseVoiceOwnershipRegistration(value: unknown): VoiceOwnershipRegistration | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'leaseId', 'revision', 'label', 'eligible', 'active']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.leaseId) ||
    !revision(input.revision) ||
    typeof input.label !== 'string' ||
    input.label.length < 1 ||
    input.label.length > 80 ||
    typeof input.eligible !== 'boolean' ||
    typeof input.active !== 'boolean'
  )
    return undefined;
  return input as unknown as VoiceOwnershipRegistration;
}

export function parseVoiceOwnershipTargets(value: unknown): VoiceOwnershipTarget[] | undefined {
  if (!Array.isArray(value) || value.length > VOICE_OWNERSHIP_MAX_TARGETS) return undefined;
  const handles = new Set<string>();
  const orders = new Set<number>();
  for (const target of value) {
    const candidate = record(target);
    if (
      candidate === undefined ||
      !exact(candidate, ['handle', 'label', 'order']) ||
      !id(candidate.handle) ||
      typeof candidate.label !== 'string' ||
      candidate.label.length < 1 ||
      candidate.label.length > 80 ||
      !Number.isSafeInteger(candidate.order) ||
      (candidate.order as number) < 1 ||
      (candidate.order as number) > 10_000 ||
      handles.has(candidate.handle) ||
      orders.has(candidate.order as number)
    )
      return undefined;
    handles.add(candidate.handle);
    orders.add(candidate.order as number);
  }
  return value as VoiceOwnershipTarget[];
}

export function parseVoiceOwnershipCommand(value: unknown): VoiceOwnershipCommand | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'commandId', 'action', 'targets']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.commandId) ||
    !action(input.action)
  )
    return undefined;
  if (input.action === 'catalog') {
    if (parseVoiceOwnershipTargets(input.targets) === undefined) return undefined;
  } else if (input.targets !== undefined) return undefined;
  return input as unknown as VoiceOwnershipCommand;
}

export function parseVoiceOwnershipAcknowledgement(value: unknown): VoiceOwnershipAcknowledgement | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'commandId', 'action', 'ok', 'active', 'error']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.commandId) ||
    !action(input.action) ||
    typeof input.ok !== 'boolean' ||
    typeof input.active !== 'boolean' ||
    (input.error !== undefined && (typeof input.error !== 'string' || input.error.length > 300))
  )
    return undefined;
  return input as unknown as VoiceOwnershipAcknowledgement;
}

export function parseVoiceOwnershipActivationRequest(value: unknown): VoiceOwnershipActivationRequest | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'requestId']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.requestId)
  )
    return undefined;
  return input as unknown as VoiceOwnershipActivationRequest;
}

export function parseVoiceOwnershipHandoffRequest(value: unknown): VoiceOwnershipHandoffRequest | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'requestId', 'handle']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.requestId) ||
    !id(input.handle)
  )
    return undefined;
  return input as unknown as VoiceOwnershipHandoffRequest;
}

export function parseBrowserVoiceOwnershipPayload(value: unknown): BrowserVoiceOwnershipPayload | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['type', 'version', 'activeSessionId']) ||
    input.type !== 'browser-media-session' ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    (input.activeSessionId !== null && !id(input.activeSessionId, 200))
  )
    return undefined;
  return input as unknown as BrowserVoiceOwnershipPayload;
}
