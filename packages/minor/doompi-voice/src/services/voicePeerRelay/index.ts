import { randomUUID } from 'node:crypto';

import {
  doomApiCallerFrom,
  type DoomApi,
  type DoomApiContext,
  type DoomApiHandler,
} from '@agimon-ai/doompi-core/package-api';
import {
  createPeerReplayGuard,
  parseRemoteSessionReference,
  peerRequestHeaders,
  peerSessionReference,
  readSessionPeerConfig,
  verifyPeerRequest,
  type SessionPeerConfig,
} from '@agimon-ai/doompi-session';

import {
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipCommand,
  parseVoiceOwnershipRegistration,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipCommand,
  type VoiceOwnershipRegistration,
} from '../../types/voiceOwnership';

const PEER_PATH = '/peer';
const PEER_OWNERSHIP_PATH = '/peer-ownership';
const PEER_ROUTE = '/api/plugins/voice/peer';
const PEER_OWNERSHIP_ROUTE = '/api/plugins/voice/peer-ownership';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BINDINGS = 512;
const brokers = new Map<string, DoomApiHandler>();
const bindings = new Map<
  string,
  {
    caller: string;
    hostId: string;
    sessionId: string;
    connectionId: string;
    activationId?: string;
    expiresAt: number;
  }
>();
const BINDING_TTL_MS = 5 * 60_000;

interface RelayRequest {
  targetSessionId: string;
  method: 'GET' | 'POST';
  path: string;
  headers: Array<[string, string]>;
  body: string;
}

export interface PairedVoiceOwnershipTarget {
  sessionId: string;
  registration: VoiceOwnershipRegistration;
}

interface VoicePeerOwnershipEndpoint {
  discover(): readonly PairedVoiceOwnershipTarget[];
  command(sessionId: string, command: VoiceOwnershipCommand): Promise<VoiceOwnershipAcknowledgement>;
}

interface VoicePeerOwnershipClient {
  discover(): Promise<PairedVoiceOwnershipTarget[]>;
  command(sessionId: string, command: VoiceOwnershipCommand): Promise<VoiceOwnershipAcknowledgement>;
}

let ownershipEndpoint: VoicePeerOwnershipEndpoint | undefined;
let ownershipClient: VoicePeerOwnershipClient | undefined;

export function registerVoicePeerOwnership(endpoint: VoicePeerOwnershipEndpoint): () => void {
  ownershipEndpoint = endpoint;
  return () => {
    if (ownershipEndpoint === endpoint) ownershipEndpoint = undefined;
  };
}

export function discoverPairedVoiceTargets(): Promise<PairedVoiceOwnershipTarget[]> {
  return ownershipClient?.discover() ?? Promise.resolve([]);
}

export async function sendPairedVoiceOwnershipCommand(
  sessionId: string,
  command: VoiceOwnershipCommand,
): Promise<VoiceOwnershipAcknowledgement> {
  if (ownershipClient === undefined) throw new Error('Paired Voice ownership transport is unavailable.');
  return ownershipClient.command(sessionId, command);
}

function callerKey(request: Request): string | undefined {
  const caller = doomApiCallerFrom(request.headers);
  if (!caller) return undefined;
  return caller.locality === 'local' ? 'local' : `remote:${caller.deviceId}`;
}

function requestIdentity(input: RelayRequest): { connectionId?: string; activationId?: string } {
  const url = new URL(input.path, 'http://doompi.local');
  if (input.method === 'GET')
    return {
      connectionId: url.searchParams.get('connectionId') ?? undefined,
      activationId: url.searchParams.get('activationId') ?? undefined,
    };
  try {
    const decoded = record(JSON.parse(Buffer.from(input.body, 'base64').toString('utf8')) as unknown);
    return {
      connectionId: typeof decoded?.connectionId === 'string' ? decoded.connectionId : undefined,
      activationId: typeof decoded?.activationId === 'string' ? decoded.activationId : undefined,
    };
  } catch {
    return {};
  }
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function relayRequest(value: unknown): RelayRequest | undefined {
  const input = record(value);
  if (!input) return undefined;
  if (typeof input.targetSessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.targetSessionId))
    return undefined;
  if (input.method !== 'GET' && input.method !== 'POST') return undefined;
  if (typeof input.path !== 'string' || !input.path.startsWith('/client/')) return undefined;
  let url: URL;
  try {
    url = new URL(input.path, 'http://doompi.local');
  } catch {
    return undefined;
  }
  if (url.origin !== 'http://doompi.local' || !url.pathname.startsWith('/client/')) return undefined;
  if (
    !Array.isArray(input.headers) ||
    input.headers.length > 32 ||
    input.headers.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string' ||
        entry[0].length > 100 ||
        entry[1].length > 1_000,
    ) ||
    typeof input.body !== 'string'
  )
    return undefined;
  let body: Buffer;
  try {
    body = Buffer.from(input.body, 'base64');
  } catch {
    return undefined;
  }
  if (body.byteLength > MAX_REQUEST_BYTES) return undefined;
  return {
    targetSessionId: input.targetSessionId,
    method: input.method,
    path: `${url.pathname}${url.search}`,
    headers: input.headers as Array<[string, string]>,
    body: input.body,
  };
}

async function boundedBody(request: Request): Promise<string | undefined> {
  const body = await request.text();
  return Buffer.byteLength(body) <= MAX_REQUEST_BYTES ? body : undefined;
}

async function dispatchLocal(input: RelayRequest): Promise<Response> {
  const broker = brokers.get(input.targetSessionId);
  if (!broker) return error(404, 'Target Voice session is unavailable.');
  const headers = new Headers();
  for (const [name, value] of input.headers) {
    const normalized = name.toLowerCase();
    if (normalized === 'content-type' || normalized.startsWith('x-doompi-voice-')) headers.append(normalized, value);
  }
  const response = await broker.fetch(
    new Request(new URL(input.path, 'http://doompi.local'), {
      method: input.method,
      headers,
      ...(input.method === 'POST' ? { body: Buffer.from(input.body, 'base64') } : {}),
    }),
  );
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_RESPONSE_BYTES) return error(502, 'Target Voice response exceeded the relay limit.');
  return Response.json({
    status: response.status,
    headers: [...response.headers.entries()].filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized === 'content-type' ||
        normalized === 'x-doompi-playback-state' ||
        normalized.startsWith('x-doompi-voice-')
      );
    }),
    body: body.toString('base64'),
  });
}

function authenticatePeer(
  config: SessionPeerConfig,
  request: Request,
  body: string,
  replayGuard: ReturnType<typeof createPeerReplayGuard> | undefined,
) {
  const peer = verifyPeerRequest(config, request, body);
  return peer && replayGuard?.admit(request) ? peer : undefined;
}

async function inboundMedia(
  context: DoomApiContext,
  request: Request,
  replayGuard: ReturnType<typeof createPeerReplayGuard> | undefined,
): Promise<Response> {
  if (!context.homeDirectory) return error(503, 'Paired Voice is not configured.');
  const config = readSessionPeerConfig(context.homeDirectory);
  if (!config) return error(503, 'Paired Voice is not configured.');
  const body = await boundedBody(request);
  if (body === undefined) return error(413, 'Voice relay request is too large.');
  const peer = authenticatePeer(config, request, body, replayGuard);
  if (!peer) return error(401, 'Paired Voice request is unauthorized or replayed.');
  let input: RelayRequest | undefined;
  try {
    input = relayRequest(JSON.parse(body) as unknown);
  } catch {
    input = undefined;
  }
  if (!input) return error(400, 'Paired Voice request is invalid.');
  if (!peer.allowedVoiceSessionIds.includes(input.targetSessionId)) return error(403, 'Peer has no Voice grant.');
  return dispatchLocal(input);
}

async function inboundOwnership(
  context: DoomApiContext,
  request: Request,
  replayGuard: ReturnType<typeof createPeerReplayGuard> | undefined,
): Promise<Response> {
  if (!context.homeDirectory) return error(503, 'Paired Voice is not configured.');
  const config = readSessionPeerConfig(context.homeDirectory);
  const body = await boundedBody(request);
  if (!config || body === undefined) return error(503, 'Paired Voice is not configured.');
  const peer = authenticatePeer(config, request, body, replayGuard);
  if (!peer) return error(401, 'Paired Voice request is unauthorized or replayed.');
  let input: Record<string, unknown> | undefined;
  try {
    input = record(JSON.parse(body) as unknown);
  } catch {
    input = undefined;
  }
  if (input?.operation === 'discover') {
    const targets = (ownershipEndpoint?.discover() ?? []).filter((target) =>
      peer.allowedVoiceSessionIds.includes(target.sessionId),
    );
    return Response.json({ targets });
  }
  if (input?.operation === 'command' && typeof input.sessionId === 'string') {
    if (!peer.allowedVoiceSessionIds.includes(input.sessionId)) return error(403, 'Peer has no Voice grant.');
    const command = parseVoiceOwnershipCommand(input.command);
    if (
      !command ||
      command.handoffId === undefined ||
      !['prepare', 'activate', 'deactivate', 'readiness', 'fence'].includes(command.action) ||
      !ownershipEndpoint
    )
      return error(400, 'Paired Voice ownership command is invalid.');
    const acknowledgement = await ownershipEndpoint.command(input.sessionId, {
      ...command,
      ...(command.handoffId === undefined ? {} : { controllerId: `peer:${peer.hostId}:${command.controllerId!}` }),
    });
    return Response.json(acknowledgement);
  }
  return error(400, 'Paired Voice ownership request is invalid.');
}

function pruneBindings(now = Date.now()): void {
  for (const [id, binding] of bindings) if (binding.expiresAt <= now) bindings.delete(id);
  while (bindings.size >= MAX_BINDINGS) {
    const oldest = bindings.keys().next().value;
    if (oldest === undefined) break;
    bindings.delete(oldest);
  }
}

async function createBinding(context: DoomApiContext, request: Request): Promise<Response> {
  const caller = callerKey(request);
  if (!caller) return error(401, 'Authenticated controller identity is required.');
  if (!context.homeDirectory) return error(503, 'Paired Voice is not configured.');
  let input: Record<string, unknown> | undefined;
  try {
    input = record(JSON.parse((await boundedBody(request)) ?? '') as unknown);
  } catch {
    input = undefined;
  }
  const target = typeof input?.target === 'string' ? parseRemoteSessionReference(input.target) : undefined;
  const connectionId = typeof input?.connectionId === 'string' ? input.connectionId : undefined;
  if (!target || !connectionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(connectionId))
    return error(400, 'Voice binding request is invalid.');
  const config = readSessionPeerConfig(context.homeDirectory);
  const peer = config?.peers.find((candidate) => candidate.hostId === target.hostId);
  if (!peer?.allowedVoiceSessionIds.includes(target.sessionId))
    return error(403, 'Remote Voice target is not granted.');
  pruneBindings();
  const binding = randomUUID();
  const expiresAt = Date.now() + BINDING_TTL_MS;
  bindings.set(binding, { caller, hostId: target.hostId, sessionId: target.sessionId, connectionId, expiresAt });
  return Response.json({ binding, expiresAt });
}

async function outbound(context: DoomApiContext, request: Request): Promise<Response> {
  const caller = callerKey(request);
  if (!caller) return error(401, 'Authenticated controller identity is required.');
  if (!context.homeDirectory) return error(503, 'Paired Voice is not configured.');
  pruneBindings();
  const bindingId = new URL(request.url).searchParams.get('binding');
  const binding = bindingId === null ? undefined : bindings.get(bindingId);
  if (!binding || binding.caller !== caller) return error(403, 'Voice media binding is invalid or expired.');
  const config = readSessionPeerConfig(context.homeDirectory);
  const peer = config?.peers.find((candidate) => candidate.hostId === binding.hostId);
  if (!config || !peer?.allowedVoiceSessionIds.includes(binding.sessionId))
    return error(403, 'Remote Voice target is not granted.');
  const body = await boundedBody(request);
  if (body === undefined) return error(413, 'Voice relay request is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return error(400, 'Voice relay request is invalid.');
  }
  const input = relayRequest({ ...record(parsed), targetSessionId: binding.sessionId });
  const identity = input === undefined ? {} : requestIdentity(input);
  if (!input || identity.connectionId !== binding.connectionId) return error(400, 'Voice relay binding mismatch.');
  if (identity.activationId !== undefined) {
    if (binding.activationId !== undefined && binding.activationId !== identity.activationId)
      return error(403, 'Voice relay activation binding mismatch.');
    binding.activationId = identity.activationId;
  }
  const peerBody = JSON.stringify(input);
  const response = await fetch(new URL(PEER_ROUTE, peer.url), {
    method: 'POST',
    headers: peerRequestHeaders(config.hostId, peer, 'POST', PEER_PATH, peerBody),
    body: peerBody,
    redirect: 'error',
    signal: AbortSignal.timeout(7_000),
  }).catch(() => undefined);
  return response ?? error(503, 'Paired Voice host is unavailable.');
}

function createOwnershipClient(config: SessionPeerConfig): VoicePeerOwnershipClient {
  const request = async (hostId: string, body: string): Promise<Response> => {
    const peer = config.peers.find((candidate) => candidate.hostId === hostId);
    if (!peer) throw new Error('Paired Voice host is not configured.');
    return fetch(new URL(PEER_OWNERSHIP_ROUTE, peer.url), {
      method: 'POST',
      headers: peerRequestHeaders(config.hostId, peer, 'POST', PEER_OWNERSHIP_PATH, body),
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(7_000),
    });
  };
  return {
    async discover() {
      const discovered: PairedVoiceOwnershipTarget[] = [];
      await Promise.all(
        config.peers.map(async (peer) => {
          try {
            const body = JSON.stringify({ operation: 'discover' });
            const response = await request(peer.hostId, body);
            const value = record(await response.json());
            if (!response.ok || !Array.isArray(value?.targets)) return;
            for (const target of value.targets) {
              const item = record(target);
              if (typeof item?.sessionId !== 'string' || !peer.allowedVoiceSessionIds.includes(item.sessionId))
                continue;
              const registration = parseVoiceOwnershipRegistration(item.registration);
              if (registration === undefined) continue;
              discovered.push({ sessionId: peerSessionReference(peer.hostId, item.sessionId), registration });
            }
          } catch {
            // An unreachable peer contributes no fresh target and is pruned by the coordinator refresh.
          }
        }),
      );
      return discovered;
    },
    async command(sessionId, command) {
      const target = parseRemoteSessionReference(sessionId);
      if (!target) throw new Error('Paired Voice target is invalid.');
      const body = JSON.stringify({ operation: 'command', sessionId: target.sessionId, command });
      const response = await request(target.hostId, body);
      const acknowledgement = response.ok ? parseVoiceOwnershipAcknowledgement(await response.json()) : undefined;
      if (!acknowledgement)
        throw new Error(`Paired Voice ownership command failed with HTTP ${String(response.status)}.`);
      return acknowledgement;
    },
  };
}

export function registerVoicePeerBroker(sessionId: string, broker: DoomApiHandler): () => void {
  if (brokers.has(sessionId)) throw new Error(`Voice peer broker '${sessionId}' is already registered.`);
  brokers.set(sessionId, broker);
  return () => {
    if (brokers.get(sessionId) === broker) brokers.delete(sessionId);
  };
}

export const voicePeerRelayApi: DoomApi = {
  basePath: 'voice',
  start(context) {
    const replayGuard = context.homeDirectory === undefined ? undefined : createPeerReplayGuard(context.homeDirectory);
    const config = context.homeDirectory === undefined ? undefined : readSessionPeerConfig(context.homeDirectory);
    const client = config === undefined ? undefined : createOwnershipClient(config);
    ownershipClient = client;
    return {
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === PEER_PATH) return inboundMedia(context, request, replayGuard);
        if (request.method === 'POST' && path === PEER_OWNERSHIP_PATH)
          return inboundOwnership(context, request, replayGuard);
        if (request.method === 'POST' && path === '/relay-binding') return createBinding(context, request);
        if (request.method === 'POST' && path === '/relay') return outbound(context, request);
        return error(404, 'Not found.');
      },
      close() {
        if (ownershipClient === client) ownershipClient = undefined;
        bindings.clear();
        replayGuard?.close();
      },
    };
  },
};
