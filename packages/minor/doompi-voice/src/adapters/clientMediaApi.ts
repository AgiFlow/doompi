import { randomUUID } from 'node:crypto';
import type { DoomApi, DoomApiContext, DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import {
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_EPOCH_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  VOICE_MEDIA_API_BASE_PATH,
  VOICE_MEDIA_BITS_PER_SAMPLE,
  type VoiceMediaCaptureActivity,
  type VoiceMediaCaptureConfiguration,
  type VoiceMediaClientEvent,
  type VoiceMediaConnectRequest,
  VOICE_MEDIA_EVENT_WAIT_NONE,
  VOICE_MEDIA_HEARTBEAT_MS,
  type VoiceMediaPlaybackDelivery,
  type VoiceMediaPlaybackOutcome,
  type VoiceMediaPlaybackResult,
  VOICE_MEDIA_PLAYBACK_STATE_HEADER,
  type VoiceMediaWake,
  VOICE_MEDIA_CHANNELS,
  VOICE_MEDIA_CONTENT_TYPE,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
  VOICE_MEDIA_SAMPLE_RATE,
} from '../types/clientMedia.ts';
import { createVoiceMediaWakePublisher, type VoiceMediaWakePublisher } from './voiceMediaWakeFile.ts';

const CLIENT_LEASE_MS = 15_000;
const CLIENT_CONNECT_WAIT_MS = 3_000;
const EVENT_WAIT_MS = 5_000;
const AUDIO_WAIT_MS = 500;
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_PLAYBACK_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_HISTORY = 64;
const MAX_IDENTIFIER_LENGTH = 200;

interface ClientLease {
  id: string;
  connectionId: string;
  capture: boolean;
  playback: boolean;
  captureActivity: boolean;
  autonomousOrchestration: boolean;
  playbackDucking: boolean;
  controlLocation: VoiceMediaConnectRequest['controlLocation'];
  lastSeenAt: number;
}

type CaptureState = 'active' | 'stopping' | 'stopped' | 'aborted' | 'failed';

interface QueuedAudioBatch {
  pcm: Uint8Array;
  activity?: VoiceMediaCaptureActivity;
}

interface HostedCapture {
  id: string;
  state: CaptureState;
  batches: QueuedAudioBatch[];
  queuedBytes: number;
  configuration: VoiceMediaCaptureConfiguration;
  lastActivity?: VoiceMediaCaptureActivity;
  error?: string;
}

interface HostedPlayback {
  id: string;
  delivery: VoiceMediaPlaybackDelivery;
  audioChunks: Uint8Array[];
  audioBytes: number;
  audioSealed: boolean;
  audioError?: string;
  result?: VoiceMediaPlaybackResult;
}

type UnsequencedEvent<Event extends VoiceMediaClientEvent> = Event extends VoiceMediaClientEvent
  ? Omit<Event, 'sequence'>
  : never;

export interface VoiceMediaApiOptions {
  internalToken?: string;
  now?: () => number;
  clientConnectWaitMs?: number;
  eventEpoch?: string;
  wakePublisher?: VoiceMediaWakePublisher;
  onNotice?: (message: string) => void;
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

function activityOrder(state: VoiceMediaCaptureActivity['state']): number {
  return state === 'listening' ? 0 : state === 'speech' ? 1 : 2;
}

function captureActivity(request: Request): VoiceMediaCaptureActivity | undefined | null {
  const state = request.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER);
  const level = request.headers.get(VOICE_MEDIA_ACTIVITY_LEVEL_HEADER);
  const elapsed = request.headers.get(VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER);
  const epoch = request.headers.get(VOICE_MEDIA_ACTIVITY_EPOCH_HEADER);
  const speechMs = request.headers.get(VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER);
  if (state === null && level === null && elapsed === null && epoch === null && speechMs === null) return undefined;
  const levelDbfs = Number(level);
  const elapsedMs = Number(elapsed);
  const activityEpoch = epoch === null ? undefined : Number(epoch);
  const classifiedSpeechMs = speechMs === null ? undefined : Number(speechMs);
  if (
    (state !== 'listening' && state !== 'speech' && state !== 'endpoint') ||
    !Number.isFinite(levelDbfs) ||
    levelDbfs < -120 ||
    levelDbfs > 0 ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    (activityEpoch !== undefined && (!Number.isSafeInteger(activityEpoch) || activityEpoch < 0)) ||
    (classifiedSpeechMs !== undefined && (!Number.isSafeInteger(classifiedSpeechMs) || classifiedSpeechMs < 0))
  )
    return null;
  return {
    state,
    levelDbfs,
    elapsedMs,
    ...(activityEpoch === undefined ? {} : { epoch: activityEpoch }),
    ...(classifiedSpeechMs === undefined ? {} : { classifiedSpeechMs }),
  };
}

class VoiceMediaBroker implements DoomApiHandler {
  private readonly now: () => number;
  private readonly internalToken: string | undefined;
  private readonly clientConnectWaitMs: number;
  private readonly eventEpoch: string;
  private readonly wakePublisher: VoiceMediaWakePublisher | undefined;
  private readonly onNotice: ((message: string) => void) | undefined;
  private readonly events: VoiceMediaClientEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private client: ClientLease | undefined;
  private capture: HostedCapture | undefined;
  private playback: HostedPlayback | undefined;
  private sequence = 0;
  private wakeFailureReported = false;
  private closed = false;

  public constructor(options: VoiceMediaApiOptions) {
    this.internalToken = options.internalToken;
    this.now = options.now ?? Date.now;
    this.clientConnectWaitMs = options.clientConnectWaitMs ?? CLIENT_CONNECT_WAIT_MS;
    this.eventEpoch = options.eventEpoch ?? randomUUID();
    if (!validId(this.eventEpoch)) throw new Error('Voice media event epoch is invalid.');
    this.wakePublisher = options.wakePublisher;
    this.onNotice = options.onNotice;
    this.publishWake();
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
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientHeartbeat)
      return this.heartbeat(request);
    if (request.method === 'GET' && url.pathname === VOICE_MEDIA_ROUTES.clientEvents) return this.nextEvent(url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientAudio)
      return this.acceptAudio(request, url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.clientCaptureStopped)
      return this.captureStopped(request);
    if (request.method === 'GET' && url.pathname === VOICE_MEDIA_ROUTES.clientPlaybackAudio)
      return this.readPlaybackAudio(url);
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
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostPlaybackAudio)
      return this.acceptPlaybackAudio(request, url);
    if (request.method === 'POST' && url.pathname === VOICE_MEDIA_ROUTES.hostPlaybackAudioEnd)
      return this.sealPlaybackAudio(request);
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
      (body.controlLocation !== 'local' && body.controlLocation !== 'remote') ||
      typeof capabilities?.capture !== 'boolean' ||
      typeof capabilities.playback !== 'boolean' ||
      typeof capabilities.captureActivity !== 'boolean' ||
      typeof capabilities.autonomousOrchestration !== 'boolean' ||
      (capabilities.playbackDucking !== undefined && typeof capabilities.playbackDucking !== 'boolean')
    ) {
      return errorResponse('Invalid voice media client declaration.', 400);
    }
    const declaration = body as unknown as VoiceMediaConnectRequest;
    const existing = this.client;
    if (
      existing !== undefined &&
      existing.id !== declaration.clientId &&
      this.now() - existing.lastSeenAt <= CLIENT_LEASE_MS &&
      !(declaration.controlLocation === 'remote' && existing.controlLocation === 'local')
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
      captureActivity: declaration.capabilities.captureActivity,
      autonomousOrchestration: declaration.capabilities.autonomousOrchestration,
      playbackDucking: declaration.capabilities.playbackDucking === true,
      controlLocation: declaration.controlLocation,
      lastSeenAt: this.now(),
    };
    this.wake();
    return Response.json({
      version: VOICE_MEDIA_PROTOCOL_VERSION,
      cursor: this.sequence,
      ...(declaration.clientKind === 'browser'
        ? { eventEpoch: this.eventEpoch, heartbeatMs: VOICE_MEDIA_HEARTBEAT_MS }
        : {}),
    });
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

  private async heartbeat(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    if (!this.matchesClient(body?.clientId, body?.connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.touchClient();
    return Response.json(this.currentWake());
  }

  private async nextEvent(url: URL): Promise<Response> {
    const clientId = url.searchParams.get('clientId');
    const connectionId = url.searchParams.get('connectionId');
    if (!this.matchesClient(clientId, connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    const eventWait = url.searchParams.get('wait');
    if (eventWait !== null && eventWait !== VOICE_MEDIA_EVENT_WAIT_NONE)
      return errorResponse('Invalid event wait mode.', 400);
    this.touchClient();
    const after = Number(url.searchParams.get('after') ?? '0');
    if (!Number.isSafeInteger(after) || after < 0) return errorResponse('Invalid event cursor.', 400);
    let event = this.events.find((candidate) => candidate.sequence > after);
    if (event === undefined && eventWait === null) {
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
    const activity = captureActivity(request);
    if (activity === null) return errorResponse('Voice capture activity is invalid.', 400);
    if (activity !== undefined && capture.configuration.activityControl !== 'client')
      return errorResponse('Voice capture activity belongs to the host.', 409);
    if (request.headers.get('content-type') !== VOICE_MEDIA_CONTENT_TYPE)
      return errorResponse('Voice audio must be PCM16.', 415);
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_AUDIO_CHUNK_BYTES) return errorResponse('Voice audio chunk is too large.', 413);
    const pcm = new Uint8Array(await request.arrayBuffer());
    if (pcm.byteLength === 0 || pcm.byteLength > MAX_AUDIO_CHUNK_BYTES || pcm.byteLength % 2 !== 0)
      return errorResponse('Voice audio chunk must contain complete PCM16 samples.', 400);
    if (capture.queuedBytes + pcm.byteLength > MAX_QUEUED_AUDIO_BYTES)
      return errorResponse('Voice audio consumer is falling behind.', 429);
    let acceptedActivity: VoiceMediaCaptureActivity | undefined;
    const previousActivity = capture.lastActivity;
    const previousEpoch = previousActivity?.epoch ?? 0;
    const nextEpoch = activity?.epoch ?? 0;
    if (
      activity !== undefined &&
      (previousActivity === undefined ||
        (activity.elapsedMs >= previousActivity.elapsedMs &&
          (nextEpoch > previousEpoch ||
            (nextEpoch === previousEpoch && activityOrder(activity.state) >= activityOrder(previousActivity.state)))))
    ) {
      acceptedActivity = activity;
      capture.lastActivity = activity;
    }
    capture.batches.push({ pcm, ...(acceptedActivity === undefined ? {} : { activity: acceptedActivity }) });
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
    if (typeof body.error === 'string' && body.error.trim() !== '') {
      this.capture.state = 'failed';
      this.capture.error = body.error.slice(0, 500);
    } else if (this.capture.state !== 'aborted' && this.capture.state !== 'failed') {
      this.capture.state = 'stopped';
    }
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
    const requested = isRecord(body?.configuration) ? body.configuration : { mode: 'manual', activityControl: 'host' };
    if (!validId(body?.captureId)) return errorResponse('Voice capture id is required.', 400);
    if (
      (requested?.mode !== 'manual' && requested?.mode !== 'autonomous') ||
      (requested.activityControl !== 'host' && requested.activityControl !== 'client') ||
      (requested.endpointSilenceMs !== undefined &&
        (typeof requested.endpointSilenceMs !== 'number' ||
          !Number.isSafeInteger(requested.endpointSilenceMs) ||
          requested.endpointSilenceMs < 250))
    )
      return errorResponse('Voice capture configuration is invalid.', 400);
    if (!(await this.clientAvailableAfterWait('capture')))
      return errorResponse('No capture-capable voice client is connected.', 503);
    if (
      this.capture !== undefined &&
      this.capture.state !== 'stopped' &&
      this.capture.state !== 'aborted' &&
      this.capture.state !== 'failed'
    )
      return errorResponse('Voice capture is already active.', 409);
    const configuration: VoiceMediaCaptureConfiguration = {
      mode: requested.mode,
      activityControl:
        requested.activityControl === 'client' &&
        this.client?.captureActivity &&
        (requested.mode !== 'autonomous' || this.client.autonomousOrchestration)
          ? 'client'
          : 'host',
      ...(typeof requested.endpointSilenceMs === 'number' ? { endpointSilenceMs: requested.endpointSilenceMs } : {}),
    };
    this.capture = { id: body.captureId, state: 'active', batches: [], queuedBytes: 0, configuration };
    this.publish({
      type: 'capture-start',
      captureId: body.captureId,
      sampleRate: VOICE_MEDIA_SAMPLE_RATE,
      channels: VOICE_MEDIA_CHANNELS,
      bitsPerSample: VOICE_MEDIA_BITS_PER_SAMPLE,
      configuration,
    });
    return Response.json({ configuration }, { status: 201 });
  }

  private async readAudio(url: URL): Promise<Response> {
    this.expireClientIfNeeded();
    const captureId = url.searchParams.get('captureId');
    if (!validId(captureId) || this.capture?.id !== captureId)
      return errorResponse('Voice capture does not match.', 409);
    let capture = this.capture;
    if (
      capture.batches.length === 0 &&
      capture.state !== 'stopped' &&
      capture.state !== 'aborted' &&
      capture.state !== 'failed'
    ) {
      await this.wait(AUDIO_WAIT_MS);
      capture = this.capture;
      if (capture?.id !== captureId) return errorResponse('Voice capture does not match.', 409);
    }
    const batch = capture.batches.shift();
    if (batch !== undefined) {
      capture.queuedBytes -= batch.pcm.byteLength;
      return new Response(batch.pcm, {
        headers: {
          'content-type': VOICE_MEDIA_CONTENT_TYPE,
          ...(batch.activity === undefined
            ? {}
            : {
                [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: batch.activity.state,
                [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: String(batch.activity.levelDbfs),
                [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: String(batch.activity.elapsedMs),
                ...(batch.activity.epoch === undefined
                  ? {}
                  : { [VOICE_MEDIA_ACTIVITY_EPOCH_HEADER]: String(batch.activity.epoch) }),
                ...(batch.activity.classifiedSpeechMs === undefined
                  ? {}
                  : { [VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER]: String(batch.activity.classifiedSpeechMs) }),
              }),
        },
      });
    }
    if (capture.state === 'aborted' || capture.state === 'failed')
      return errorResponse(capture.error ?? 'Voice media client stopped capture unexpectedly.', 410);
    return new Response(null, { status: 204, headers: { 'x-doompi-capture-state': capture.state } });
  }

  private async stopCapture(request: Request, abort: boolean): Promise<Response> {
    const body = await jsonRecord(request);
    if (!validId(body?.captureId) || this.capture?.id !== body.captureId)
      return errorResponse('Voice capture does not match.', 409);
    if (abort) {
      this.capture.state = 'aborted';
      this.capture.batches = [];
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
    if (!(await this.clientAvailableAfterWait('playback')))
      return errorResponse('No playback-capable voice client is connected.', 503);
    if (this.playback !== undefined && this.playback.result === undefined)
      return errorResponse('Voice playback is already active.', 409);
    const delivery: VoiceMediaPlaybackDelivery = this.client?.controlLocation === 'remote' ? 'streamed' : 'client';
    this.playback = { id: body.playbackId, delivery, audioChunks: [], audioBytes: 0, audioSealed: false };
    this.publish({
      type: 'playback-start',
      playbackId: body.playbackId,
      text: body.text,
      delivery,
      ...(typeof body.voice === 'string' && body.voice !== '' ? { voice: body.voice } : {}),
      ...(typeof body.rate === 'number' && Number.isFinite(body.rate) ? { rate: body.rate } : {}),
    });
    return Response.json({ delivery }, { status: 201 });
  }

  private async acceptPlaybackAudio(request: Request, url: URL): Promise<Response> {
    const playbackId = url.searchParams.get('playbackId');
    const playback = this.playback;
    if (!validId(playbackId) || playback?.id !== playbackId || playback.delivery !== 'streamed')
      return errorResponse('Voice playback does not match streamed delivery.', 409);
    if (playback.audioSealed) return errorResponse('Voice playback audio is already sealed.', 409);
    if (request.headers.get('content-type') !== VOICE_MEDIA_CONTENT_TYPE)
      return errorResponse('Voice playback audio must be PCM16.', 415);
    const pcm = new Uint8Array(await request.arrayBuffer());
    if (pcm.byteLength === 0 || pcm.byteLength > MAX_AUDIO_CHUNK_BYTES || pcm.byteLength % 2 !== 0)
      return errorResponse('Voice playback audio chunk must contain complete PCM16 samples.', 400);
    if (playback.audioBytes + pcm.byteLength > MAX_PLAYBACK_AUDIO_BYTES)
      return errorResponse('Voice playback audio is too large.', 413);
    playback.audioChunks.push(pcm);
    playback.audioBytes += pcm.byteLength;
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async sealPlaybackAudio(request: Request): Promise<Response> {
    const body = await jsonRecord(request);
    const playback = this.playback;
    if (!validId(body?.playbackId) || playback?.id !== body.playbackId || playback.delivery !== 'streamed')
      return errorResponse('Voice playback does not match streamed delivery.', 409);
    playback.audioSealed = true;
    if (typeof body.error === 'string' && body.error.trim() !== '') playback.audioError = body.error.slice(0, 500);
    this.wake();
    return new Response(null, { status: 204 });
  }

  private async readPlaybackAudio(url: URL): Promise<Response> {
    const clientId = url.searchParams.get('clientId');
    const connectionId = url.searchParams.get('connectionId');
    const playbackId = url.searchParams.get('playbackId');
    if (!this.matchesClient(clientId, connectionId))
      return errorResponse('Voice media client does not own this session.', 409);
    this.touchClient();
    let playback = this.playback;
    if (!validId(playbackId) || playback?.id !== playbackId || playback.delivery !== 'streamed')
      return errorResponse('Voice playback does not match streamed delivery.', 409);
    if (playback.audioChunks.length === 0 && !playback.audioSealed) {
      await this.wait(AUDIO_WAIT_MS);
      playback = this.playback;
      if (playback?.id !== playbackId) return errorResponse('Voice playback does not match.', 409);
    }
    const chunk = playback.audioChunks.shift();
    if (chunk !== undefined) {
      playback.audioBytes -= chunk.byteLength;
      return new Response(chunk, { headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE } });
    }
    if (playback.audioError) return errorResponse(playback.audioError, 410);
    return new Response(null, {
      status: 204,
      headers: { [VOICE_MEDIA_PLAYBACK_STATE_HEADER]: playback.audioSealed ? 'sealed' : 'active' },
    });
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

  private async clientAvailableAfterWait(capability: 'capture' | 'playback'): Promise<boolean> {
    if (this.clientAvailable(capability)) return true;
    if (this.clientConnectWaitMs > 0) await this.wait(this.clientConnectWaitMs);
    return this.clientAvailable(capability);
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
    this.publishWake();
  }

  private currentWake(): VoiceMediaWake {
    return { eventEpoch: this.eventEpoch, sequence: this.sequence };
  }

  private publishWake(): void {
    if (this.wakePublisher === undefined) return;
    try {
      this.wakePublisher.publish(this.currentWake());
      this.wakeFailureReported = false;
    } catch (error) {
      if (this.wakeFailureReported) return;
      this.wakeFailureReported = true;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.onNotice?.(`voice media wake publication failed (${message})`);
    }
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
    let wakePublisher: VoiceMediaWakePublisher | undefined;
    if (context.sessionId !== undefined) {
      try {
        wakePublisher = createVoiceMediaWakePublisher(context.sessionId);
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        context.onNotice(`voice media wake publisher unavailable (${message})`);
      }
    }
    return createVoiceMediaApi({
      internalToken: context.internalToken,
      wakePublisher,
      onNotice: (message) => context.onNotice(message),
    });
  },
};
