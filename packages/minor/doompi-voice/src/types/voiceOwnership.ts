export const VOICE_OWNERSHIP_PROTOCOL_VERSION = 1;
export const VOICE_OWNERSHIP_LEASE_MS = 15_000;
export const VOICE_OWNERSHIP_MAX_TARGETS = 32;
export const VOICE_OWNERSHIP_ROUTES = {
  state: '/hub/ownership/state',
  command: '/hub/ownership/command',
  request: '/host/ownership/transfer',
} as const;

export type VoiceOwnershipPhase = 'prepare' | 'quiesce' | 'activate' | 'commit' | 'abort' | 'resume';

export interface VoiceOwnershipRegistration {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  leaseId: string;
  revision: number;
  label: string;
  eligible: boolean;
  active: boolean;
  requiresBrowserBind: boolean;
}

export interface VoiceOwnershipTarget {
  handle: string;
  label: string;
}

export interface VoiceOwnershipView {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  epoch: string;
  generation: number;
  revision: number;
  owner: boolean;
  transaction: boolean;
  targets: VoiceOwnershipTarget[];
}

export interface VoiceOwnershipCommand {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  epoch: string;
  generation: number;
  revision: number;
  phase: VoiceOwnershipPhase;
  source: boolean;
  catalog?: VoiceOwnershipView;
}

export interface VoiceOwnershipAcknowledgement {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  epoch: string;
  generation: number;
  revision: number;
  phase: VoiceOwnershipPhase;
  ok: boolean;
  listening?: boolean;
  error?: string;
}

export interface VoiceOwnershipTransferRequest {
  version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
  requestId: string;
  handle: string;
}

export type BrowserVoiceOwnershipPayload =
  | { type: 'browser-media-runtime'; version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION }
  | {
      type: 'browser-media-command';
      version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
      epoch: string;
      generation: number;
      revision: number;
      action: 'detach' | 'attach' | 'ready';
    }
  | {
      type: 'browser-media-ack';
      version: typeof VOICE_OWNERSHIP_PROTOCOL_VERSION;
      epoch: string;
      generation: number;
      revision: number;
      action: 'detach' | 'attach' | 'ready';
      ok: boolean;
      listening?: boolean;
      error?: string;
    };
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

export function parseVoiceOwnershipRegistration(value: unknown): VoiceOwnershipRegistration | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'leaseId', 'revision', 'label', 'eligible', 'active', 'requiresBrowserBind']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.leaseId) ||
    !revision(input.revision) ||
    typeof input.label !== 'string' ||
    input.label.length < 1 ||
    input.label.length > 80 ||
    typeof input.eligible !== 'boolean' ||
    typeof input.active !== 'boolean' ||
    typeof input.requiresBrowserBind !== 'boolean'
  )
    return undefined;
  return input as unknown as VoiceOwnershipRegistration;
}

export function parseVoiceOwnershipCommand(value: unknown): VoiceOwnershipCommand | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'epoch', 'generation', 'revision', 'phase', 'source', 'catalog']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.epoch) ||
    !revision(input.generation) ||
    !revision(input.revision) ||
    !['prepare', 'quiesce', 'activate', 'commit', 'abort', 'resume'].includes(String(input.phase)) ||
    typeof input.source !== 'boolean'
  )
    return undefined;
  if (input.catalog !== undefined) {
    const catalog = parseVoiceOwnershipView(input.catalog);
    if (catalog === undefined || catalog.epoch !== input.epoch) return undefined;
  }
  return input as unknown as VoiceOwnershipCommand;
}

export function parseVoiceOwnershipAcknowledgement(value: unknown): VoiceOwnershipAcknowledgement | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'epoch', 'generation', 'revision', 'phase', 'ok', 'listening', 'error']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.epoch) ||
    !revision(input.generation) ||
    !revision(input.revision) ||
    !['prepare', 'quiesce', 'activate', 'commit', 'abort', 'resume'].includes(String(input.phase)) ||
    typeof input.ok !== 'boolean' ||
    (input.listening !== undefined && typeof input.listening !== 'boolean') ||
    (input.error !== undefined && (typeof input.error !== 'string' || input.error.length > 300))
  )
    return undefined;
  return input as unknown as VoiceOwnershipAcknowledgement;
}

export function parseVoiceOwnershipView(value: unknown): VoiceOwnershipView | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'epoch', 'generation', 'revision', 'owner', 'transaction', 'targets']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.epoch) ||
    !revision(input.generation) ||
    !revision(input.revision) ||
    typeof input.owner !== 'boolean' ||
    typeof input.transaction !== 'boolean' ||
    !Array.isArray(input.targets) ||
    input.targets.length > VOICE_OWNERSHIP_MAX_TARGETS
  )
    return undefined;
  for (const target of input.targets) {
    const candidate = record(target);
    if (
      candidate === undefined ||
      !exact(candidate, ['handle', 'label']) ||
      !id(candidate.handle) ||
      typeof candidate.label !== 'string' ||
      candidate.label.length < 1 ||
      candidate.label.length > 80
    )
      return undefined;
  }
  return input as unknown as VoiceOwnershipView;
}

export function parseVoiceOwnershipTransferRequest(value: unknown): VoiceOwnershipTransferRequest | undefined {
  const input = record(value);
  if (
    input === undefined ||
    !exact(input, ['version', 'requestId', 'handle']) ||
    input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION ||
    !id(input.requestId) ||
    !id(input.handle)
  )
    return undefined;
  return input as unknown as VoiceOwnershipTransferRequest;
}

export function parseBrowserVoiceOwnershipPayload(value: unknown): BrowserVoiceOwnershipPayload | undefined {
  const input = record(value);
  if (input === undefined || input.version !== VOICE_OWNERSHIP_PROTOCOL_VERSION || typeof input.type !== 'string')
    return undefined;
  if (input.type === 'browser-media-runtime')
    return exact(input, ['type', 'version']) ? (input as unknown as BrowserVoiceOwnershipPayload) : undefined;
  const keys =
    input.type === 'browser-media-command'
      ? ['type', 'version', 'epoch', 'generation', 'revision', 'action']
      : ['type', 'version', 'epoch', 'generation', 'revision', 'action', 'ok', 'listening', 'error'];
  if (
    !['browser-media-command', 'browser-media-ack'].includes(input.type) ||
    !exact(input, keys) ||
    !id(input.epoch) ||
    !revision(input.generation) ||
    !revision(input.revision) ||
    !['detach', 'attach', 'ready'].includes(String(input.action)) ||
    (input.type === 'browser-media-ack' &&
      (typeof input.ok !== 'boolean' ||
        (input.listening !== undefined && typeof input.listening !== 'boolean') ||
        (input.error !== undefined && (typeof input.error !== 'string' || input.error.length > 300))))
  )
    return undefined;
  return input as unknown as BrowserVoiceOwnershipPayload;
}
