import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import {
  VOICE_MEDIA_API_BASE_PATH,
  VOICE_MEDIA_BITS_PER_SAMPLE,
  type VoiceMediaClientEvent,
  type VoiceMediaConnectRequest,
  type VoiceMediaPlaybackOutcome,
  type VoiceMediaPlaybackResult,
  VOICE_MEDIA_CHANNELS,
  VOICE_MEDIA_CONTENT_TYPE,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
  VOICE_MEDIA_SAMPLE_RATE,
} from '../types/clientMedia.ts';

const CLIENT_LEASE_MS = 15_000;
const EVENT_WAIT_MS = 5_000;
const AUDIO_WAIT_MS = 500;
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_HISTORY = 64;
const MAX_IDENTIFIER_LENGTH = 200;

interface ClientLease {
  id: string;
  connectionId: string;
  capture: boolean;
  playback: boolean;
  lastSeenAt: number;
}

type CaptureState = 'active' | 'stopping' | 'stopped' | 'aborted' | 'failed';

interface HostedCapture {
  id: string;
  state: CaptureState;
  chunks: Uint8Array[];
  queuedBytes: number;
}

interface HostedPlayback {
  id: string;
  result?: VoiceMediaPlaybackResult;
}

type UnsequencedEvent<Event extends VoiceMediaClientEvent> = Event extends VoiceMediaClientEvent
  ? Omit<Event, 'sequence'>
  : never;

export interface VoiceMediaApiOptions {
  internalToken?: string;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function jsonRecord(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function playbackOutcome(value: unknown): VoiceMediaPlaybackOutcome | undefined {
  if (value === 'completed' || value === 'stopped' || value === 'aborted' || value === 'failed') return value;
  return undefined;
}

class VoiceMediaBroker implements DoomApiHandler {
  private readonly now: () => number;
  private readonly internalToken: string | undefined;
  private readonly events: VoiceMediaClientEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private client: ClientLease | undefined;
  private capture: HostedCapture | undefined;
  private playback: HostedPlayback | undefined;
  private sequence = 0;
  private closed = false;

  public constructor(options: VoiceMediaApiOptions) {
    this.internalToken = options.internalToken;
    this.now = options.now ?? Date.now;
  }

  public fetch(request: Request): Promise<Response> | Response {
    if (this.closed) return errorResponse('Voice media transport is closed.', 503);
    const url = new URL(request.url);
    if (url.pathname.startsWith('/host/')) {
      const authorized =
        this.internalToken !== undefined && request.headers.get('authorization') === `Bearer ${this.internalToken}`;
      if (!authorized) return errorResponse('Not found.', 404);
    }

    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientConnect) return this.connect(request);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientDisconnect)
      return this.disconnect(request);
    if (request.method === 'GET' && url.pathname === VOICE_MEDIA_ROUTES.clientEvents) return this.nextEvent(url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientAudio)
      return this.acceptAudio(request, url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientCaptureStopped)
      return this.captureStopped(request);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientPlaybackResult)
      return this.playbackFinished(request);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostCaptureStart)
      return this.startCapture(request);
    if (request.method === 'GET' && url.pathname === VOICE_MEDIA_ROUTES.hostCaptureAudio) return this.readAudio(url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostCaptureStop)
      return this.stopCapture(request, false);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostCaptureAbort)
      return this.stopCapture(request, true);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostPlaybackStart)
      return this.startPlayback(request);
    if (request.method === 'GET' && url.pathname === VOICE_MEDIA_ROUTES.hostPlaybackResult)
      return this.readPlaybackResult(url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostPlaybackStop)
      return this.stopPlayback(request, false);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostPlaybackAbort)
      return this.stopPlayback(request, true);
    return errorResponse('Not found.', 404);
  }

  public close(): void {
    this.closed = true;
    this.failActiveClientWork('Voice media transport closed.');
    this.wake();
  }

  private async connect(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    const capabilities = isRecord(body?.capabilities) ? body.capabilities : undefined;
    if (
      body?.version !== VOICE_MEDIA_PROTOCOL_VERSION ||
      !validId(body.clientId) ||
      !validId(body.connectionId) ||
      (body.clientKind !== 'browser' && body.clientKind !== 'native') ||
      typeof capabilities?.capture !== 'boolean' ||
      typeof capabilities.playback !== 'boolean'
    ) {
      return errorResponse('Invalid voice media client declaration.', 400);
    }
    const declaration = body as unknown as VoiceMediaConnectRequest;
    const existing = this.client;
    if (
      existing !== undefined &&
      existing.id !== declaration.clientId &&
      this.now() - existing.lastSeenAt <= CLIENT_LEASE_MS
    ) {
      return errorResponse('Another client owns voice media for this session.', 409);
    }
    if (
      existing !== undefined &&
      (existing.id !== declaration.clientId || existing.connectionId !== declaration.connectionId)
    ) {
      this.failActiveClientWork('Voice media client reconnected.');
      this.wake();
    }
    this.client = {
      id: declaration.clientId,
      connectionId: declaration.connectionId,
      capture: declaration.capabilities.capture,
      playback: declaration.capabilities.playback,
      lastSeenAt: this.now(),
    };
    return Response.json({ version: VOICE_MEDIA_PROTOCOL_VERSION, cursor: this.sequence });
  }

  private async disconnect(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    if (!this.matchesClient(body?.clientId, body?.connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.client = undefined;
    this.failActiveClientWork('Voice media client disconnected.');
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async nextEvent(url: URL): Promise<Response> {
    const clientId = url.searchParams.get('clientId');
    const connectionId = url.searchParams.get('connectionId');
    if (!this.matchesClient(clientId, connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.touchClient();
    const after = Number(url.searchParams.get('after') ?? '0');
    if (!Number.isSafeInteger(after) || after < 0) return errorResponse('Invalid event cursor.', 400);
    let event = this.events.find((candidate) => candidate.sequence > after);
    if (event === undefined) {
      await this.wait(EVENT_WAIT_MS);
      if (!this.matchesClient(clientId, connectionId))
        return errorResponse('Voice media client does not own this session.', 409);
      this.touchClient();
      event = this.events.find((candidate) => candidate.sequence > after);
    }
    return event === undefined ? new Response(null, { status: 204 }) : Response.json(event);
  }

  private async acceptAudio(request: Request, url: URL): Promise<Response> {
    const clientId = url.searchParams.get('clientId');
    const connectionId = url.searchParams.get('connectionId');
    const captureId = url.searchParams.get('captureId');
    if (!this.matchesClient(clientId, connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.touchClient();
    const capture = this.capture;
    if (
      !validId(captureId) ||
      capture?.id !== captureId ||
      (capture.state !== 'active' && capture.state !== 'stopping')
    )
      return errorResponse('Voice capture is not active.', 409);
    if (request.headers.get('content-type') !== VOICE_MEDIA_CONTENT_TYPE)
      return errorResponse('Voice audio must be PCM16.', 415);
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_AUDIO_CHUNK_BYTES) return errorResponse('Voice audio chunk is too large.', 413);
    const pcm = new Uint8Array(await request.arrayBuffer());
    if (pcm.byteLength === 0 || pcm.byteLength > MAX_AUDIO_CHUNK_BYTES || pcm.byteLength % 2 !== 0)
      return errorResponse('Voice audio chunk must contain complete PCM16 samples.', 400);
    if (capture.queuedBytes + pcm.byteLength > MAX_QUEUED_AUDIO_BYTES)
      return errorResponse('Voice audio consumer is falling behind.', 429);
    capture.chunks.push(pcm);
    capture.queuedBytes += pcm.byteLength;
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async captureStopped(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    if (!this.matchesClient(body?.clientId, body?.connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.touchClient();
    if (!validId(body?.captureId) || this.capture?.id !== body.captureId)
      return errorResponse('Voice capture does not match.', 409);
    if (this.capture.state !== 'aborted' && this.capture.state !== 'failed') this.capture.state = 'stopped';
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async playbackFinished(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    if (!this.matchesClient(body?.clientId, body?.connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.touchClient();
    const outcome = playbackOutcome(body?.outcome);
    if (!validId(body?.playbackId) || this.playback?.id !== body.playbackId || outcome === undefined)
      return errorResponse('Voice playback does not match.', 409);
    this.playback.result = {
      playbackId: body.playbackId,
      outcome,
      ...(typeof body.error === 'string' ? { error: body.error.slice(0, 500) } : {}),
    };
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async startCapture(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    if (!validId(body?.captureId)) return errorResponse('Voice capture id is required.', 400);
    if (!this.clientAvailable('capture')) return errorResponse('No capture-capable voice client is connected.', 503);
    if (
      this.capture !== undefined &&
      this.capture.state !== 'stopped' &&
      this.capture.state !== 'aborted' &&
      this.capture.state !== 'failed'
    )
      return errorResponse('Voice capture is already active.', 409);
    this.capture = { id: body.captureId, state: 'active', chunks: [], queuedBytes: 0 };
    this.publish({
      type: 'capture-start',
      captureId: body.captureId,
      sampleRate: VOICE_MEDIA_SAMPLE_RATE,
      channels: VOICE_MEDIA_CHANNELS,
      bitsPerSample: VOICE_MEDIA_BITS_PER_SAMPLE,
    });
    return new Response(null, { status: 201 });
  }

  private async readAudio(url: URL): Promise<Response> {
    this.expireClientIfNeeded();
    const captureId = url.searchParams.get('captureId');
    if (!validId(captureId) || this.capture?.id !== captureId)
      return errorResponse('Voice capture does not match.', 409);
    let capture = this.capture;
    if (
      capture.chunks.length === 0 &&
      capture.state !== 'stopped' &&
      capture.state !== 'aborted' &&
      capture.state !== 'failed'
    ) {
      await this.wait(AUDIO_WAIT_MS);
      capture = this.capture;
      if (capture?.id !== captureId) return errorResponse('Voice capture does not match.', 409);
    }
    if (capture.chunks.length > 0) {
      const pcm = new Uint8Array(capture.queuedBytes);
      let offset = 0;
      for (const chunk of capture.chunks) {
        pcm.set(chunk, offset);
        offset += chunk.byteLength;
      }
      capture.chunks = [];
      capture.queuedBytes = 0;
      return new Response(pcm, { headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE } });
    }
    if (capture.state === 'aborted' || capture.state === 'failed')
      return errorResponse('Voice media client stopped capture unexpectedly.', 410);
    return new Response(null, { status: 204, headers: { 'x-doompi-capture-state': capture.state } });
  }

  private async stopCapture(request: Request, abort: boolean): Promise<Response> {
    const body = await jsonRecord(request);
    if (!validId(body?.captureId) || this.capture?.id !== body.captureId)
      return errorResponse('Voice capture does not match.', 409);
    if (abort) {
      this.capture.state = 'aborted';
      this.capture.chunks = [];
      this.capture.queuedBytes = 0;
      this.publish({ type: 'capture-abort', captureId: body.captureId });
    } else if (this.capture.state === 'active') {
      this.capture.state = 'stopping';
      this.publish({ type: 'capture-stop', captureId: body.captureId });
    }
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async startPlayback(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    if (!validId(body?.playbackId) || typeof body.text !== 'string' || body.text.trim() === '')
      return errorResponse('Voice playback id and text are required.', 400);
    if (!this.clientAvailable('playback')) return errorResponse('No playback-capable voice client is connected.', 503);
    if (this.playback !== undefined && this.playback.result === undefined)
      return errorResponse('Voice playback is already active.', 409);
    this.playback = { id: body.playbackId };
    this.publish({
      type: 'playback-start',
      playbackId: body.playbackId,
      text: body.text,
      ...(typeof body.voice === 'string' && body.voice !== '' ? { voice: body.voice } : {}),
      ...(typeof body.rate === 'number' && Number.isFinite(body.rate) ? { rate: body.rate } : {}),
    });
    return new Response(null, { status: 201 });
  }

  private async readPlaybackResult(url: URL): Promise<Response> {
    this.expireClientIfNeeded();
    const playbackId = url.searchParams.get('playbackId');
    if (!validId(playbackId) || this.playback?.id !== playbackId)
      return errorResponse('Voice playback does not match.', 409);
    if (this.playback.result === undefined) await this.wait(AUDIO_WAIT_MS);
    return this.playback.result === undefined
      ? new Response(null, { status: 204 })
      : Response.json(this.playback.result);
  }

  private async stopPlayback(request: Request, abort: boolean): Promise<Response> {
    const body = await jsonRecord(request);
    if (!validId(body?.playbackId) || this.playback?.id !== body.playbackId)
      return errorResponse('Voice playback does not match.', 409);
    if (this.playback.result === undefined)
      this.publish({ type: abort ? 'playback-abort' : 'playback-stop', playbackId: body.playbackId });
    return new Response(null, { status: 204 });
  }

  private matchesClient(clientId: unknown, connectionId: unknown): clientId is string {
    return (
      validId(clientId) &&
      validId(connectionId) &&
      this.client?.id === clientId &&
      this.client.connectionId === connectionId
    );
  }

  private touchClient(): void {
    if (this.client) this.client.lastSeenAt = this.now();
  }

  private clientAvailable(capability: 'capture' | 'playback'): boolean {
    const client = this.client;
    if (client === undefined || this.now() - client.lastSeenAt > CLIENT_LEASE_MS) return false;
    return client[capability];
  }

  private expireClientIfNeeded(): void {
    if (this.client === undefined || this.now() - this.client.lastSeenAt <= CLIENT_LEASE_MS) return;
    this.client = undefined;
    this.failActiveClientWork('Voice media client lease expired.');
    this.wake();
  }

  private publish(event: UnsequencedEvent<VoiceMediaClientEvent>): void {
    this.sequence += 1;
    this.events.push({ ...event, sequence: this.sequence } as VoiceMediaClientEvent);
    if (this.events.length > MAX_EVENT_HISTORY) this.events.splice(0, this.events.length - MAX_EVENT_HISTORY);
    this.wake();
  }

  private failActiveClientWork(message: string): void {
    if (this.capture !== undefined && this.capture.state !== 'stopped' && this.capture.state !== 'aborted')
      this.capture.state = 'failed';
    if (this.playback !== undefined && this.playback.result === undefined) {
      this.playback.result = { playbackId: this.playback.id, outcome: 'failed', error: message };
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const waiter of this.waiters) waiter();
  }
}

export function createVoiceMediaApi(options: VoiceMediaApiOptions = {}): DoomApiHandler {
  return new VoiceMediaBroker(options);
}

export const api: DoomApi = {
  basePath: VOICE_MEDIA_API_BASE_PATH,
  start(context: DoomApiContext): DoomApiHandler {
    return createVoiceMediaApi({ internalToken: context.internalToken });
  },
};
