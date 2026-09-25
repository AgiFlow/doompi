import type { ApiResult } from '@agimon-ai/doompi-core/web';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';

import { voice, voiceMedia } from '../../../../../../../generated/client';
import {
  VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_EPOCH_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  type VoiceMediaCaptureActivity,
  VOICE_MEDIA_CONTENT_TYPE,
  type VoiceMediaClientEvent,
  type VoiceMediaConnectResult,
  type VoiceMediaCapabilities,
  VOICE_MEDIA_EVENT_WAIT_NONE,
  type VoiceMediaPlaybackResult,
  VOICE_MEDIA_PLAYBACK_STATE_HEADER,
  type VoiceMediaWake,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
  type VoiceMediaTransport,
} from '../../../../../../types/clientMedia';
import { REALTIME_ROUTES, type RealtimeBrowserState } from '../../../../../../types/realtime';
import { parseVoiceMediaWakePayload, waitForVoiceMediaWake } from '../../_lib/voiceMediaWakeStore';

const JSON_CONTENT_TYPE = 'application/json';
const MAX_HEARTBEAT_MS = 60_000;
const MAX_EVENT_EPOCH_LENGTH = 200;
const CONTROL_REQUEST_DEADLINE_MS = 8_000;
const REALTIME_NEGOTIATION_DEADLINE_MS = 20_000;

interface PushConnection {
  eventEpoch: string;
  heartbeatMs: number;
}

function pushConnection(result: VoiceMediaConnectResult): PushConnection | undefined {
  return typeof result.eventEpoch === 'string' &&
    result.eventEpoch.length > 0 &&
    result.eventEpoch.length <= MAX_EVENT_EPOCH_LENGTH &&
    Number.isSafeInteger(result.heartbeatMs) &&
    (result.heartbeatMs ?? 0) > 0 &&
    (result.heartbeatMs ?? 0) <= MAX_HEARTBEAT_MS
    ? { eventEpoch: result.eventEpoch, heartbeatMs: result.heartbeatMs as number }
    : undefined;
}

/**
 * The message a declared call reported.
 *
 * `status: 0` is the one case the transport never answered at all, which the
 * hand-built `fetch` used to surface as the thrown network error. The client
 * catches that and reports it as a status, so the status is what is said.
 */
function resultError(result: Extract<ApiResult<unknown>, { ok: false }>): Error {
  return new Error(
    result.error === '' ? `Voice media request failed with status ${String(result.status)}.` : result.error,
  );
}

async function responseError(response: Response): Promise<Error> {
  let message = `Voice media request failed with status ${String(response.status)}.`;
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // A response without JSON still carries its HTTP status above.
  }
  return new Error(message);
}

function jsonBody(value: object): RequestInit {
  return { method: 'POST', headers: { 'content-type': JSON_CONTENT_TYPE }, body: JSON.stringify(value) };
}

function route(path: string, query: Record<string, string | number | undefined> = {}): string {
  const url = new URL(path, 'http://doompi.local');
  for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
  return `${url.pathname}${url.search}`;
}

function cancelResponseBody(response: Response | undefined): void {
  try {
    void response?.body?.cancel().catch(() => undefined);
  } catch {
    // Injected transports may expose a nonstandard response body.
  }
}

async function boundedControlRequest<T>(
  input: string,
  init: RequestInit,
  deadlineMs: number,
  consume: (response: Response) => Promise<T> | T,
  parentSignal?: AbortSignal,
  transport: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
    sealedTransport.fetch(input, init),
): Promise<T> {
  const deadlineController = new AbortController();
  const signal = parentSignal ?? deadlineController.signal;
  let response: Response | undefined;
  let cancelled = false;
  let cancellationReason: unknown;
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    cancellationReason = reason;
    deadlineController.abort(reason);
    cancelResponseBody(response);
    rejectCancellation(reason);
  };
  const abortParent = (): void =>
    cancel(parentSignal?.reason ?? new DOMException('Voice media control request was aborted.', 'AbortError'));
  const timer = setTimeout(() => cancel(new Error('Voice media control request timed out.')), deadlineMs);
  parentSignal?.addEventListener('abort', abortParent, { once: true });

  let fetched: Promise<Response>;
  try {
    fetched = transport(input, { ...init, signal });
  } catch (error) {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortParent);
    throw error;
  }
  const operation = fetched.then(async (result) => {
    response = result;
    if (cancelled) {
      cancelResponseBody(result);
      throw cancellationReason;
    }
    return consume(result);
  });

  try {
    if (parentSignal?.aborted) abortParent();
    return await Promise.race([operation, cancellation]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortParent);
  }
}

export class BrowserVoiceMediaTransport implements VoiceMediaTransport {
  private push: PushConnection | undefined;
  private controlLocation: 'local' | 'remote' | undefined;
  private binding: { id: string; connectionId: string; expiresAt: number } | undefined;

  /** A null session binds the single host-global companion, never a Pi agent session. */
  public constructor(private readonly sessionId: string | null) {}

  /**
   * This session's `voice-media` mount, resolved per call.
   *
   * Not cached: the address is read through the host's session-to-workspace
   * binding, and a held client would outlive a rebinding.
   */
  private media(): ReturnType<typeof voiceMedia.session> {
    if (this.sessionId === null) throw new Error('PCM routes are session-scoped, not global live media.');
    return voiceMedia.session(this.sessionId);
  }

  private remote(): boolean {
    return (
      this.sessionId !== null &&
      /^peer\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.sessionId)
    );
  }

  private async fetch(path: string, directUrl: string, init: RequestInit = {}): Promise<Response> {
    if (!this.remote()) return sealedTransport.fetch(directUrl, init);
    const request = new Request(new URL(path, 'http://doompi.local'), init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const requestUrl = new URL(request.url);
    let connectionId = requestUrl.searchParams.get('connectionId') ?? undefined;
    if (!connectionId && bytes.byteLength > 0) {
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes)) as { connectionId?: unknown };
        if (typeof value.connectionId === 'string') connectionId = value.connectionId;
      } catch {
        connectionId = undefined;
      }
    }
    if (!connectionId) throw new Error('Paired Voice request has no connection binding.');
    if (
      !this.binding ||
      this.binding.connectionId !== connectionId ||
      this.binding.expiresAt <= Date.now() + CONTROL_REQUEST_DEADLINE_MS
    ) {
      const issued = await voice.global.relayBinding({ body: { target: this.sessionId, connectionId } });
      if (!issued.ok) throw resultError(issued);
      const value = issued.data as { binding?: unknown; expiresAt?: unknown };
      if (typeof value.binding !== 'string' || !Number.isSafeInteger(value.expiresAt))
        throw new Error('Paired Voice media binding is invalid.');
      this.binding = { id: value.binding, connectionId, expiresAt: value.expiresAt as number };
    }
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = await voice.global.relay({
      query: { binding: this.binding.id },
      body: {
        targetSessionId: '',
        method: request.method === 'GET' ? 'GET' : 'POST',
        path,
        headers: [...request.headers.entries()],
        body: btoa(binary),
      },
    });
    if (!result.ok) throw resultError(result);
    const envelope = result.data as { status?: unknown; headers?: unknown; body?: unknown };
    if (!Number.isSafeInteger(envelope.status) || !Array.isArray(envelope.headers) || typeof envelope.body !== 'string')
      throw new Error('Paired Voice relay response is invalid.');
    const decoded = atob(envelope.body);
    const body = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return new Response(body.byteLength === 0 ? null : body, {
      status: envelope.status as number,
      headers: envelope.headers as Array<[string, string]>,
    });
  }

  private async remoteResult<T>(path: string, directUrl: string, init: RequestInit): Promise<ApiResult<T>> {
    const response = await this.fetch(path, directUrl, init);
    let data: unknown;
    try {
      data = response.status === 204 ? undefined : await response.json();
    } catch {
      data = undefined;
    }
    if (response.ok) return { ok: true, status: response.status, data: data as T, response };
    return {
      ok: false,
      status: response.status,
      error:
        typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
          ? data.error
          : `Voice media request failed with status ${String(response.status)}.`,
      data,
      response,
    };
  }

  public async connect(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<VoiceMediaConnectResult> {
    this.push = undefined;
    const controlLocation = sealedTransport.active() ? 'remote' : 'local';
    const result = await this.declareClient(clientId, connectionId, capabilities, controlLocation);
    if (!result.ok) throw resultError(result);
    const connected = result.data;
    this.controlLocation = controlLocation;
    // Global media has no session-addressed wake channel; use authenticated bounded HTTP polling.
    this.push = this.sessionId === null ? undefined : pushConnection(connected);
    return connected;
  }

  public async refreshCapabilities(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<void> {
    const controlLocation = this.controlLocation;
    if (controlLocation === undefined) throw new Error('Voice media client is not connected.');
    const result = await this.declareClient(clientId, connectionId, capabilities, controlLocation);
    if (!result.ok) throw resultError(result);
  }

  public async disconnect(clientId: string, connectionId: string): Promise<void> {
    try {
      const body = { clientId, connectionId };
      const result =
        this.sessionId === null
          ? await voiceMedia.global.clientDisconnect({ body })
          : this.remote()
            ? await this.remoteResult(VOICE_MEDIA_ROUTES.clientDisconnect, '', jsonBody(body))
            : await this.media().clientDisconnect({ body });
      if (!result.ok && result.status !== 409) throw resultError(result);
    } finally {
      this.push = undefined;
      this.controlLocation = undefined;
      this.binding = undefined;
    }
  }

  public async nextEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined> {
    const push = this.push;
    const sessionId = this.sessionId;
    if (push === undefined || sessionId === null) return this.fetchEvent(clientId, connectionId, after, signal, false);
    while (!signal.aborted) {
      const channelWake = await waitForVoiceMediaWake(sessionId, push.eventEpoch, after, push.heartbeatMs, signal);
      if (signal.aborted) return undefined;
      const wake = channelWake ?? (await this.heartbeat(clientId, connectionId));
      if (wake.eventEpoch !== push.eventEpoch) throw new Error('Voice media broker changed.');
      if (wake.sequence <= after) continue;
      const event = await this.fetchEvent(clientId, connectionId, after, signal, true);
      if (event === undefined) throw new Error('Voice media wake could not be resolved.');
      return event;
    }
    return undefined;
  }

  private declareClient(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
    controlLocation: 'local' | 'remote',
  ): Promise<ApiResult<VoiceMediaConnectResult>> {
    const body = {
      version: VOICE_MEDIA_PROTOCOL_VERSION,
      clientId,
      connectionId,
      clientKind: 'browser' as const,
      controlLocation,
      capabilities,
    };
    return this.sessionId === null
      ? voiceMedia.global.clientConnect({ body })
      : this.remote()
        ? this.remoteResult(VOICE_MEDIA_ROUTES.clientConnect, '', jsonBody(body))
        : this.media().clientConnect({ body });
  }

  private async fetchEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
    nonblocking: boolean,
  ): Promise<VoiceMediaClientEvent | undefined> {
    const path = route(VOICE_MEDIA_ROUTES.clientEvents, {
      clientId,
      connectionId,
      after,
      ...(nonblocking ? { wait: VOICE_MEDIA_EVENT_WAIT_NONE } : {}),
    });
    const query = { clientId, connectionId, after, ...(nonblocking ? { wait: VOICE_MEDIA_EVENT_WAIT_NONE } : {}) };
    const directUrl =
      this.sessionId === null
        ? voiceMedia.global.clientEvents.url({ query })
        : this.remote()
          ? ''
          : this.media().clientEvents.url({ query });
    return boundedControlRequest(
      directUrl,
      {},
      CONTROL_REQUEST_DEADLINE_MS,
      async (response) => {
        if (response.status === 204) return undefined;
        if (!response.ok) throw await responseError(response);
        return (await response.json()) as VoiceMediaClientEvent;
      },
      signal,
      (_input, init) => this.fetch(path, directUrl, init),
    );
  }

  private heartbeat(clientId: string, connectionId: string): Promise<VoiceMediaWake> {
    const path = VOICE_MEDIA_ROUTES.clientHeartbeat;
    const directUrl =
      this.sessionId === null
        ? voiceMedia.global.clientHeartbeat.url()
        : this.remote()
          ? ''
          : this.media().clientHeartbeat.url();
    return boundedControlRequest(
      directUrl,
      jsonBody({ clientId, connectionId }),
      CONTROL_REQUEST_DEADLINE_MS,
      async (response) => {
        if (!response.ok) throw await responseError(response);
        const wake = parseVoiceMediaWakePayload(await response.json());
        if (wake === null) throw new Error('Voice media heartbeat response is invalid.');
        return wake;
      },
      undefined,
      (_input, init) => this.fetch(path, directUrl, init),
    );
  }

  public async sendAudio(
    clientId: string,
    connectionId: string,
    captureId: string,
    pcm: Uint8Array,
    activity?: VoiceMediaCaptureActivity,
  ): Promise<void> {
    const query = { clientId, connectionId, captureId };
    const headers = {
      'content-type': VOICE_MEDIA_CONTENT_TYPE,
      ...(activity === undefined
        ? {}
        : {
            [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: activity.state,
            [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: String(activity.levelDbfs),
            [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: String(activity.elapsedMs),
            ...(activity.epoch === undefined ? {} : { [VOICE_MEDIA_ACTIVITY_EPOCH_HEADER]: String(activity.epoch) }),
            ...(activity.classifiedSpeechMs === undefined
              ? {}
              : { [VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER]: String(activity.classifiedSpeechMs) }),
            ...(activity.echoDiscriminatedSpeechMs === undefined
              ? {}
              : { [VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER]: String(activity.echoDiscriminatedSpeechMs) }),
          }),
    };
    const body = new Blob([new Uint8Array(pcm)], { type: VOICE_MEDIA_CONTENT_TYPE });
    const result = this.remote()
      ? await this.remoteResult(route(VOICE_MEDIA_ROUTES.clientAudio, query), '', { method: 'POST', headers, body })
      : await this.media().clientAudio({ query, headers, body });
    if (!result.ok) throw resultError(result);
  }

  public async captureStopped(
    clientId: string,
    connectionId: string,
    captureId: string,
    error?: string,
  ): Promise<void> {
    const body = { clientId, connectionId, captureId, ...(error === undefined ? {} : { error }) };
    const result = this.remote()
      ? await this.remoteResult(VOICE_MEDIA_ROUTES.clientCaptureStopped, '', jsonBody(body))
      : await this.media().clientCaptureStopped({ body });
    if (!result.ok) throw resultError(result);
  }

  /**
   * Polls the streamed playback bytes.
   *
   * Addressed through the declaration but fetched directly, because the answer
   * is PCM rather than JSON: the call surface buffers and parses a body before
   * it returns, so `result.response` reaches this route with its body already
   * consumed. `url()` exists for exactly this.
   */
  public async receivePlaybackAudio(
    clientId: string,
    connectionId: string,
    playbackId: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const path = route(VOICE_MEDIA_ROUTES.clientPlaybackAudio, { clientId, connectionId, playbackId });
    const url = this.remote()
      ? ''
      : this.media().clientPlaybackAudio.url({ query: { clientId, connectionId, playbackId } });
    while (!signal.aborted) {
      const response = await this.fetch(path, url, { signal });
      if (response.status === 200 && response.headers.get('content-type')?.startsWith(VOICE_MEDIA_CONTENT_TYPE)) {
        const chunk = new Uint8Array(await response.arrayBuffer());
        chunks.push(chunk);
        byteLength += chunk.byteLength;
        continue;
      }
      if (response.status === 204 && response.headers.get(VOICE_MEDIA_PLAYBACK_STATE_HEADER) === 'sealed') {
        const pcm = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          pcm.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return pcm;
      }
      if (response.status === 204) continue;
      throw await responseError(response);
    }
    throw new DOMException('Voice playback audio was aborted.', 'AbortError');
  }

  public async playbackFinished(
    clientId: string,
    connectionId: string,
    result: VoiceMediaPlaybackResult,
  ): Promise<void> {
    const body = { clientId, connectionId, ...result };
    const answer = this.remote()
      ? await this.remoteResult(VOICE_MEDIA_ROUTES.clientPlaybackResult, '', jsonBody(body))
      : await this.media().clientPlaybackResult({ body });
    if (!answer.ok) throw resultError(answer);
  }

  public async realtimeNegotiate(
    clientId: string,
    connectionId: string,
    activationId: string,
    sdp: string,
    signal: AbortSignal,
  ): Promise<string> {
    const path = REALTIME_ROUTES.clientNegotiate;
    const directUrl =
      this.sessionId === null
        ? voiceMedia.global.realtimeNegotiate.url()
        : this.remote()
          ? ''
          : this.media().realtimeNegotiate.url();
    return boundedControlRequest(
      directUrl,
      jsonBody({ clientId, connectionId, activationId, sdp }),
      REALTIME_NEGOTIATION_DEADLINE_MS,
      async (response) => {
        if (!response.ok) throw await responseError(response);
        const body: unknown = await response.json();
        if (typeof body !== 'object' || body === null || typeof (body as { sdp?: unknown }).sdp !== 'string')
          throw new Error('Realtime negotiation response is invalid.');
        return (body as { sdp: string }).sdp;
      },
      signal,
      (_input, init) => this.fetch(path, directUrl, init),
    );
  }

  public async realtimeEvent(
    clientId: string,
    connectionId: string,
    activationId: string,
    event: string,
  ): Promise<void> {
    const directUrl =
      this.sessionId === null
        ? voiceMedia.global.realtimeEvent.url()
        : this.remote()
          ? ''
          : this.media().realtimeEvent.url();
    await this.postRealtime(REALTIME_ROUTES.clientEvent, directUrl, {
      clientId,
      connectionId,
      activationId,
      event,
    });
  }

  public async realtimeState(
    clientId: string,
    connectionId: string,
    activationId: string,
    state: RealtimeBrowserState,
  ): Promise<void> {
    const directUrl =
      this.sessionId === null
        ? voiceMedia.global.realtimeState.url()
        : this.remote()
          ? ''
          : this.media().realtimeState.url();
    await this.postRealtime(REALTIME_ROUTES.clientState, directUrl, {
      clientId,
      connectionId,
      activationId,
      state,
    });
  }

  private postRealtime(path: string, directUrl: string, body: object): Promise<void> {
    return boundedControlRequest(
      directUrl,
      jsonBody(body),
      CONTROL_REQUEST_DEADLINE_MS,
      async (response) => {
        if (!response.ok) throw await responseError(response);
      },
      undefined,
      (_input, init) => this.fetch(path, directUrl, init),
    );
  }
}
