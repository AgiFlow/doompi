import { randomUUID } from 'node:crypto';

import {
  doomApiCallerFrom,
  type DoomApi,
  type DoomApiContext,
  type DoomApiHandler,
} from '@agimon-ai/doompi-core/package-api';
import {
  parseRemoteSessionReference,
  peerRequestHeaders,
  readSessionPeerConfig,
  verifyPeerRequest,
} from '@agimon-ai/doompi-session';

const PEER_PATH = '/peer';
const PEER_ROUTE = '/api/plugins/voice/peer';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const brokers = new Map<string, DoomApiHandler>();
const bindings = new Map<
  string,
  { caller: string; hostId: string; sessionId: string; connectionId: string; expiresAt: number }
>();
const BINDING_TTL_MS = 5 * 60_000;

interface RelayRequest {
  targetSessionId: string;
  method: 'GET' | 'POST';
  path: string;
  headers: Array<[string, string]>;
  body: string;
}

function callerKey(request: Request): string | undefined {
  const caller = doomApiCallerFrom(request.headers);
  if (!caller) return undefined;
  return caller.locality === 'local' ? 'local' : `remote:${caller.deviceId}`;
}

function requestConnectionId(input: RelayRequest): string | undefined {
  const url = new URL(input.path, 'http://doompi.local');
  if (input.method === 'GET') return url.searchParams.get('connectionId') ?? undefined;
  try {
    const decoded = record(JSON.parse(Buffer.from(input.body, 'base64').toString('utf8')) as unknown);
    return typeof decoded?.connectionId === 'string' ? decoded.connectionId : undefined;
  } catch {
    return undefined;
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

async function inbound(context: DoomApiContext, request: Request): Promise<Response> {
  if (!context.homeDirectory) return error(503, 'Paired Voice is not configured.');
  const config = readSessionPeerConfig(context.homeDirectory);
  if (!config) return error(503, 'Paired Voice is not configured.');
  const body = await boundedBody(request);
  if (body === undefined) return error(413, 'Voice relay request is too large.');
  const peer = verifyPeerRequest(config, request, body);
  if (!peer) return error(401, 'Paired Voice request is unauthorized.');
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
  const binding = randomUUID();
  const expiresAt = Date.now() + BINDING_TTL_MS;
  bindings.set(binding, { caller, hostId: target.hostId, sessionId: target.sessionId, connectionId, expiresAt });
  return Response.json({ binding, expiresAt });
}

async function outbound(context: DoomApiContext, request: Request): Promise<Response> {
  const caller = callerKey(request);
  if (!caller) return error(401, 'Authenticated controller identity is required.');
  if (!context.homeDirectory) return error(503, 'Paired Voice is not configured.');
  const bindingId = new URL(request.url).searchParams.get('binding');
  const binding = bindingId === null ? undefined : bindings.get(bindingId);
  if (!binding || binding.caller !== caller || binding.expiresAt <= Date.now()) {
    if (bindingId && binding && binding.expiresAt <= Date.now()) bindings.delete(bindingId);
    return error(403, 'Voice media binding is invalid or expired.');
  }
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
  if (!input || requestConnectionId(input) !== binding.connectionId) return error(400, 'Voice relay binding mismatch.');
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
    return {
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'POST' && path === PEER_PATH) return inbound(context, request);
        if (request.method === 'POST' && path === '/relay-binding') return createBinding(context, request);
        if (request.method === 'POST' && path === '/relay') return outbound(context, request);
        return error(404, 'Not found.');
      },
      close: () => undefined,
    };
  },
};
